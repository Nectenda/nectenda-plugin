import { MarkdownView, TFile } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type NectendaPlugin from './main';
import type { ContentSync } from './content-sync';
import type { SyncProvider } from './provider-router';
import { log } from './logger';
import { seatFor, seatColour, type Person } from './presence';
import { resolveMapping, type FolderMapping } from './folder-mapping';

export { resolveMapping, type FolderMapping };


// Generate a deterministic color from a username
/**
 * Which theme Obsidian is currently in. Presence colours have separate light
 * and dark values, and the wrong one is a caret that disappears into the page.
 */
function currentTheme(): 'light' | 'dark' {
  return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
}

/**
 * A collaborator's caret and selection colours.
 *
 * Replaces a hash straight to `hsl(anyHue, 70%, 45%)`, which could land on
 * brand gold, on a near-twin of somebody already present, or — worst — in the
 * green band, where `vine` means *synced* and a person read as a status.
 * `presence.ts` explains the palette and the hole it avoids.
 *
 * The selection colour carries alpha rather than being a pale tint. This is the
 * fix for a real defect: the old CSS put `opacity` on the selection decoration,
 * which wraps the *text*, so a collaborator's selected words rendered at 30% —
 * and multi-line at 15%, close to invisible. A background with alpha leaves the
 * glyphs on top fully opaque, which is what the design system's RemoteSelection
 * achieves by putting the tint on its own layer.
 *
 * ## Why the colour is broadcast rather than computed on each client
 *
 * Computing locally from the seat would let every client paint in its own
 * theme. y-codemirror renders the caret itself, with the colour inlined on the
 * element, and gives no hook for per-user CSS — so the only way to make the
 * presence circles match the carets *exactly*, which is the point of them, is
 * for both to read the same broadcast value. The cost is that a light-theme
 * user's caret keeps its light-theme lightness when viewed on a dark theme. The
 * hue is right either way, so the person is still identifiable; only the
 * contrast is not ideal.
 */
function userColor(username: string): { seat: number; color: string; light: string } {
  const seat = seatFor(username);
  const colour = seatColour(seat, currentTheme());
  return { seat, color: colour, light: withAlpha(colour, 0.28) };
}

/** The design system tints a selection at 0.28 over the page. */
function withAlpha(colour: string, alpha: number): string {
  if (colour.startsWith('oklch(')) {
    return `${colour.slice(0, -1)} / ${alpha})`;
  }
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return `${colour}${a}`;
}

/**
 * Given a file path and folder mappings, find which shared folder it belongs to
 * and return the shared folder ID + relative path within it.
 */

/**
 * How the bind waits for a subscription that may already have happened, or may
 * never happen. Ten half-seconds: long enough to cover an IndexedDB load on a
 * cold start, short enough that a stranded editor recovers before anyone
 * reaches for the mouse.
 */
const SUBSCRIPTION_WAIT_MS = 500;
const SUBSCRIPTION_WAIT_TRIES = 10;

export class EditorBridge {
  private plugin: NectendaPlugin;
  private contentSync: ContentSync;
  private provider: SyncProvider;
  private username: string;
  private collabExts: Extension[];
  /** A pending wait for a document's subscription, so it can be cancelled. */
  private subscriptionWait: { event: string; cb: () => void; timer: ReturnType<typeof setInterval> } | null = null;
  private currentFile: string | null = null;
  private currentDocName: string | null = null;
  private onPresenceChange: ((people: Person[]) => void) | null = null;
  private awarenessHandler: (() => void) | null = null;

  constructor(
    plugin: NectendaPlugin,
    contentSync: ContentSync,
    provider: SyncProvider,
    username: string,
    collabExts: Extension[],
  ) {
    this.plugin = plugin;
    this.contentSync = contentSync;
    this.provider = provider;
    this.username = username;
    this.collabExts = collabExts;
  }

  setPresenceCallback(cb: (people: Person[]) => void): void {
    this.onPresenceChange = cb;
  }

  start(): void {
    const ref = this.plugin.app.workspace.on('active-leaf-change', () => {
      this.onActiveLeafChange();
    });
    this.plugin.registerEvent(ref);

    // A rename changes the open file's path without changing the leaf, so
    // 'active-leaf-change' never fires and the editor stays bound to the old
    // document name — live cursors and presence stop for that file until the
    // user clicks away and back.
    //
    // This matters most in the vault that did *not* initiate the rename, where
    // FileSync applies it programmatically via vault.rename() and nothing else
    // disturbs the leaf.
    //
    // VaultWatcher is started before EditorBridge, so its own rename handler
    // has already pointed ContentSync at the new document name by the time this
    // runs and acquireDoc finds it connected.
    const renameRef = this.plugin.app.vault.on('rename', (file, oldPath) => {
      if (oldPath !== this.currentFile) return;
      if (!(file instanceof TFile)) return;
      this.onActiveLeafChange();
    });
    this.plugin.registerEvent(renameRef);

    // The broadcast colour is sampled from the theme at the moment presence is
    // announced, so switching light/dark mid-session would leave everyone else
    // seeing the old theme's value — and the local presence circles reading it
    // back, so a user's own screen would disagree with itself.
    //
    // 'css-change' is Obsidian's signal for exactly this; it also fires for
    // snippet and appearance changes, which is harmless here because
    // re-announcing an unchanged state is a no-op to every reader.
    const themeRef = this.plugin.app.workspace.on('css-change', () => {
      this.reannouncePresence();
    });
    this.plugin.registerEvent(themeRef);

    this.onActiveLeafChange();
  }

  /**
   * Re-send the local presence state with a colour for the current theme.
   *
   * Deliberately does nothing when there is no bound document or no local state
   * yet. A null local state means "this document is background-synced and
   * advertises nobody", and turning that into a real state here would announce
   * a user who is not looking at the file.
   */
  private reannouncePresence(): void {
    if (!this.currentDocName) return;
    const awareness = this.provider.getAwareness(this.currentDocName);
    const existing = awareness?.getLocalState();
    if (!awareness || !existing) return;

    const colors = userColor(this.username);
    awareness.setLocalState({
      ...existing,
      user: {
        name: this.username,
        seat: colors.seat,
        color: colors.color,
        colorLight: colors.light,
      },
    });
  }

  stop(): void {
    this.unbindCollab();
  }

  /** Re-evaluate the active file after folder mappings change */
  reconnectActiveFile(): void {
    this.unbindCollab();
    this.onActiveLeafChange();
  }

  private onActiveLeafChange(): void {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);

    if (!view?.file) {
      this.unbindCollab();
      return;
    }

    const filePath = view.file.path;

    if (filePath === this.currentFile) return;

    this.unbindCollab();

    // Resolve folder mapping
    const mappings = this.plugin.settings.folderMappings || [];
    const resolved = resolveMapping(filePath, mappings);

    if (!resolved) {
      return;
    }

    const { sharedFolderId, relativePath } = resolved;
    // Usually synchronous: a folder's paths are derived when it connects. But
    // a file can be opened before that finishes — measured at 2ms early — and a
    // rename produces a path that has never been derived at all. Deriving and
    // retrying is what keeps those cases binding; giving up here silently left
    // the editor unbound, which is the data-loss path.
    const docName = this.plugin.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) {
      void this.plugin.docIndex
        .ref(sharedFolderId, relativePath)
        .then(() => {
          // currentFile is still whatever it was, so the guard at the top of
          // onActiveLeafChange will not swallow this retry.
          this.onActiveLeafChange();
        })
        .catch((err: unknown) => {
          log.warn('No document id for this file — folder keys may be missing', {
            filePath,
            error: String(err),
          });
        });
      return;
    }

    this.currentFile = filePath;
    this.currentDocName = docName;

    // Acquire the Y.Doc from ContentSync (connects on-demand if needed)
    const acquired = this.contentSync.acquireDoc(docName);
    if (!acquired) {
      // acquireDoc asks ContentSync to connect the file, and connecting is now
      // asynchronous — it has to derive the document id first — so the document
      // is not there the instant we ask. Waiting for the subscription is the
      // same deferral used when awareness is not ready, and without it an
      // editor opened before its folder finished connecting never binds.
      log.debug('Document not connected yet — waiting for its subscription', { docName });
      this.awaitSubscription(docName, filePath, () => {
        // Clear currentFile before re-entering. It was set just above, and the
        // guard at the top of onActiveLeafChange returns immediately when the
        // active file already matches — so a plain retry here is swallowed and
        // the editor never binds. It then stays unbound until the user clicks
        // away and back, which is how this surfaced: two vaults with the same
        // file open, neither showing the other's cursor on a fresh connection,
        // and needing a click-away on *both* to recover.
        //
        // The sibling deferral above sidesteps the guard by returning before
        // currentFile is set. This path cannot, so it undoes it instead.
        //
        // Why this is intermittent rather than constant: acquireDoc calls
        // connectFile and re-reads its map, so it usually returns the document
        // with a null awareness, and installCollab's own deferral handles that
        // case without ever re-entering this method. Only an outright null —
        // an unknown path, a missing mapping, or connectFile not populating
        // synchronously — reaches here.
        this.currentFile = null;
        this.onActiveLeafChange();
      });
      return;
    }

    const { ytext } = acquired;
    const file = view.file;

    // Install yCollab once provider has synced this doc
    const installCollab = async () => {
      if (this.currentFile !== filePath) return;

      // No awareness yet means the document has no subscription yet:
      // ContentSync calls provider.subscribe only once IndexedDB has finished
      // loading, and a file opened immediately at startup gets here first.
      //
      // Retry when the subscription appears rather than giving up. Returning
      // here used to be permanent — nothing rescheduled the bind — so the
      // editor stayed unbound until the user switched away and back, which put
      // an offline vault straight back on the path where typed edits are
      // overwritten on reconnect.
      const awareness = this.provider.getAwareness(docName);
      if (!awareness) {
        log.debug('Editor opened before the document was subscribed — waiting', { docName });
        this.awaitSubscription(docName, filePath, installCollab);
        return;
      }

      // Fold in anything the file has that the document does not, before the
      // document is treated as authoritative below. Without this, binding
      // discards an external change — and because binding also stops the
      // disk-to-document path, nothing would pick it up afterwards.
      await this.contentSync.reconcileFromDisk(docName);
      if (this.currentFile !== filePath) return;

      const localContent = file ? await this.plugin.app.vault.read(file) : '';
      if (this.currentFile !== filePath) return;

      // Announce presence. Must be setLocalState, not setLocalStateField:
      // subscriptions start with a null local state so background-synced files
      // do not advertise anyone, and setLocalStateField is a no-op on null.
      const colors = userColor(this.username);
      awareness.setLocalState({
        user: {
          name: this.username,
          // `seat` travels so a reader can tell two collaborators apart even
          // if a future client renders colour differently; `color` and
          // `colorLight` are what y-codemirror inlines on the caret and the
          // selection, and what the presence circles read so the two agree.
          seat: colors.seat,
          color: colors.color,
          colorLight: colors.light,
        },
      });

      // Track online users.
      //
      // Counts distinct people, not awareness entries: awareness is keyed by a
      // random per-Y.Doc clientID, so the same person with two devices open —
      // or a tab that has not yet been swept after a reload — would otherwise
      // inflate the count.
      this.awarenessHandler = () => {
        if (!this.onPresenceChange) return;
        // Deduped by name, not by clientID, for the reason given above — and
        // the first colour seen for a name wins, so a person with two devices
        // open does not flicker between two entries.
        const people = new Map<string, Person>();
        for (const [clientId, state] of awareness.getStates()) {
          const user = (state as { user?: { name?: string; color?: string } } | undefined)?.user;
          const name = user?.name ?? `client:${clientId}`;
          if (!people.has(name)) {
            people.set(name, { name, color: user?.color ?? seatColour(seatFor(name), currentTheme()) });
          }
        }
        // Report the raw entries whenever they outnumber the people, which is
        // the only case worth a line. y-codemirror draws one caret per
        // awareness entry while the circles and the status count draw one per
        // person, so this is exactly the gap in which a reader sees a cursor
        // belonging to nobody — a peer that has gone away and not yet been
        // swept, or a subscription of ours that was never torn down. The `age`
        // separates those: a dead peer's entry ages, ours is renewed forever.
        if (awareness.getStates().size > people.size) {
          const now = Date.now();
          log.debug('Presence has more entries than people', {
            docName,
            entries: awareness.getStates().size,
            people: people.size,
            detail: [...awareness.getStates()].map(([clientId, state]) => {
              const s = state as { user?: { name?: string }; cursor?: unknown } | undefined;
              const meta = (awareness as unknown as {
                meta: Map<number, { lastUpdated: number }>;
              }).meta.get(clientId);
              return {
                clientId,
                mine: clientId === awareness.clientID,
                name: s?.user?.name ?? null,
                hasCursor: s?.cursor != null,
                ageMs: meta ? now - meta.lastUpdated : null,
              };
            }),
          });
        }

        this.onPresenceChange([...people.values()]);
      };
      awareness.on('change', this.awarenessHandler);
      this.awarenessHandler();

      // What the editor bound to, and whether it seeded.
      //
      // Seeding inserts characters the server may already hold under different
      // identities, so a wrong decision here duplicates content on the next
      // merge. Recording the inputs makes that decision reviewable after the
      // fact — the merged result alone cannot say which side introduced what.
      log.debug('Binding editor', {
        docName,
        ytextLength: ytext.length,
        diskLength: localContent.length,
        connected: this.provider.isConnected(),
        synced: this.provider.isSynced(docName),
        willSeed: ytext.length === 0 && localContent.length > 0,
      });

      // Seed if ytext is empty
      if (ytext.length === 0 && localContent.length > 0) {
        ytext.doc!.transact(() => {
          ytext.insert(0, localContent);
        });
      }

      // Set editor to match ytext (source of truth)
      const ytextContent = ytext.toString();
      if (view.editor.getValue() !== ytextContent) {
        view.editor.setValue(ytextContent);
      }

      // Install yCollab — editor and ytext already match
      const collabExtension = yCollab(ytext, awareness);
      const undoKeymap = keymap.of(yUndoManagerKeymap);

      this.collabExts.length = 0;
      this.collabExts.push(collabExtension, undoKeymap);

      this.plugin.app.workspace.updateOptions();

      // Only now does CodeMirror own the document. Until this point ContentSync
      // must keep reconciling disk against the CRDT, or edits made before the
      // document syncs — offline, most obviously — are lost.
      this.contentSync.setEditorBound(docName, true);
    };

    // Bind now when the document is synced — or when nothing is connected.
    //
    // Waiting unconditionally for `synced` means an editor opened while offline
    // never binds, because that event cannot arrive with no server to sync
    // against. Typing then reaches CodeMirror and nothing else, and when the
    // connection returns the synced document is written over the file, taking
    // the edit with it. That is silent data loss, and it survived earlier
    // rounds of this work because the file on disk looks correct until the
    // moment it is overwritten.
    //
    // Binding while disconnected is safe. The document is a CRDT: edits land in
    // ytext, the provider records the subscription as having unsent work, and
    // the delta is pushed on the next reconnect. The seeding above only fires
    // for a genuinely empty document — a previously synced file is restored
    // from IndexedDB and so is never empty — which is what keeps a disconnected
    // bind from duplicating content the server is about to deliver.
    //
    // Connected but not yet synced still waits, because there the document
    // really is about to arrive and seeding from a stale disk copy would
    // insert characters the server is holding under different identities.
    if (this.provider.isSynced(docName) || !this.provider.isConnected()) {
      installCollab();
    } else {
      const onSynced = () => {
        this.provider.off(`synced:${docName}`, onSynced);
        installCollab();
      };
      this.provider.on(`synced:${docName}`, onSynced);
    }
  }

  /**
   * Run `retry` once the document has a subscription, unless the editor moved on.
   *
   * Cancellable: the listener is remembered so unbindCollab can drop it,
   * otherwise switching files quickly would leave a callback that binds a
   * document the user is no longer looking at.
   *
   * **Not purely event-driven, and that is the point.** `subscribed:<docName>`
   * is emitted once, synchronously, inside `subscribe`. Waiting on it alone
   * loses two ways: the subscribe may already have happened before this
   * listener attached, and it may never happen at all — a document the router
   * cannot place throws out of subscribe and emits nothing. Either way the
   * editor was left unbound for good, showing no collaborators and announcing
   * none, until the person selected a different file and came back. That is how
   * this was reported.
   *
   * So the condition is re-checked on attach, and a bounded poll backs the
   * event up. The poll is the safety net for an edge that was missed, not the
   * mechanism — the event still does the work in the ordinary case.
   */
  private awaitSubscription(docName: string, filePath: string, retry: () => void): void {
    this.cancelSubscriptionWait();
    let attempts = 0;
    const settle = () => {
      this.cancelSubscriptionWait();
      if (this.currentFile !== filePath) return;
      retry();
    };
    // Already subscribed: the event is gone and will not come again.
    if (this.provider.getAwareness(docName)) {
      settle();
      return;
    }
    const timer = setInterval(() => {
      attempts += 1;
      if (this.currentFile !== filePath || this.provider.getAwareness(docName)) {
        settle();
        return;
      }
      if (attempts >= SUBSCRIPTION_WAIT_TRIES) {
        this.cancelSubscriptionWait();
        // Release the guard on the way out. `onActiveLeafChange` returns early
        // when the active path already matches `currentFile`, so leaving it set
        // would wedge this file shut: every later leaf change for it swallowed,
        // and the only way back a trip to another file. Clearing it means the
        // next chance to bind is taken.
        this.currentFile = null;
        log.warn('Gave up waiting for a document to be subscribed; the editor is not bound', {
          docName, filePath,
        });
      }
    }, SUBSCRIPTION_WAIT_MS);
    this.subscriptionWait = { event: `subscribed:${docName}`, cb: settle, timer };
    this.provider.on(`subscribed:${docName}`, settle);
  }

  private cancelSubscriptionWait(): void {
    if (!this.subscriptionWait) return;
    this.provider.off(this.subscriptionWait.event, this.subscriptionWait.cb);
    clearInterval(this.subscriptionWait.timer);
    this.subscriptionWait = null;
  }

  private unbindCollab(): void {
    this.cancelSubscriptionWait();
    if (this.currentDocName) {
      // Release awareness handler
      const awareness = this.provider.getAwareness(this.currentDocName);
      if (this.awarenessHandler) {
        if (awareness) awareness.off('change', this.awarenessHandler);
        this.awarenessHandler = null;
      }

      // Withdraw presence. The document stays subscribed for background sync,
      // so without this a closed file would keep showing our cursor to peers
      // until y-protocols' staleness sweep.
      if (awareness) awareness.setLocalState(null);

      // Release doc back to ContentSync for background sync
      this.contentSync.releaseDoc(this.currentDocName);
      this.currentDocName = null;
      this.currentFile = null;

      this.collabExts.length = 0;
      this.plugin.app.workspace.updateOptions();
      if (this.onPresenceChange) {
        this.onPresenceChange([]);
      }
    }
  }
}
