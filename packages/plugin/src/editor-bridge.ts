import { MarkdownView, TFile } from 'obsidian';
import * as Y from 'yjs';
import { keymap, type EditorView } from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { App, EventRef } from 'obsidian';
import type { DocIndex } from './doc-index';
import type { ContentSync } from './content-sync';
import type { SyncProvider } from './provider-router';
import type { ProviderEvent } from './multiplexed-provider';
import type { Awareness } from 'y-protocols/awareness';
import { log } from './logger';
import { PRESENCE_VERSION } from '@nectenda/shared';
import { applySeed, buildSeedUpdate, type SeedUpdate } from './seed-update';
import { seatFor, seatColour, type Person } from './presence';
import { goToInNote, remotePointers, type RemotePointers } from './remote-pointer';
import { replayEdits } from './text-merge';
import type { PendingEdits } from './pending-edits';
import { resolveMapping, type FolderMapping } from './folder-mapping';
import type { EditorWiring } from './editor-wiring';

/** The CodeMirror view inside an Obsidian editor. Internal API, hence the reach. */
function editorViewOf(view: MarkdownView): EditorView | null {
  return (view.editor as unknown as { cm?: EditorView } | undefined)?.cm ?? null;
}

/** A `window.setTimeout`/`setInterval` handle: a number.
 *
 * Spelled out rather than `ReturnType<typeof window.setTimeout>`, which looks
 * tidier and is wrong here. `@types/node` is a devDependency, so the global is
 * overloaded, and `ReturnType<>` resolves the *last* overload — Node's
 * `Timeout` — while the call itself resolves the DOM one and returns a number.
 * The two disagree and nothing says so until an assignment fails.
 */
type TimerHandle = number;

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
export function userColor(username: string): { seat: number; color: string; light: string } {
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
 * The people in a presence list, as one comparable string: who, and in which
 * colour. Order matters, because the circles are drawn in that order.
 */
export function peopleKey(people: readonly Person[]): string {
  return JSON.stringify(people.map((p) => [p.name, p.color]));
}

/**
 * Which remote carets have just appeared.
 *
 * y-codemirror builds a new caret element every time a caret moves — its
 * widget's `updateDOM` returns false — so a CSS animation on the caret itself
 * replays on every keystroke the other person types, and their caret and name
 * blink (measured: 32 restarts in 30 keystrokes). A remote caret must never
 * blink: in someone else's colour it reads as your own. So the ease-in is
 * keyed to *arrival* instead: this reports whether any client now has a caret
 * that did not have one at the last change. Leaving and coming back counts as
 * arriving again, because the caret really did go away.
 *
 * Pure over the awareness states it is handed, so it can be tested without an
 * editor. `own` is this client's id, whose caret is never drawn here.
 */
export function caretArrivals(own: number): (states: Map<number, unknown>) => boolean {
  let present = new Set<number>();
  return (states) => {
    const now = new Set<number>();
    for (const [clientId, state] of states) {
      if (clientId === own) continue;
      if ((state as { cursor?: unknown } | null)?.cursor != null) now.add(clientId);
    }
    const arrived = [...now].some((id) => !present.has(id));
    present = now;
    return arrived;
  };
}

/** How long an arrival marks the editor: the 240 ms ease-in, and a frame to spare. */
export const CARET_ARRIVAL_MS = 320;

/** How often an unchanged set of people is reported again. */
export const PRESENCE_REFRESH_MS = 1000;

/**
 * An awareness `change` handler that reports the people present, once per
 * actual change of who is there.
 *
 * Counts distinct people, not awareness entries: awareness is keyed by a
 * random per-Y.Doc clientID, so the same person with two devices open — or a
 * tab that has not yet been swept after a reload — would otherwise inflate the
 * count.
 *
 * Every caret move and every pointer move is an awareness change, and the
 * circles are redrawn wholesale, so an unchanged set of people is reported at
 * most once per `PRESENCE_REFRESH_MS`. Reporting every change rebuilt the
 * header twenty times a second while a collaborator moved their mouse, and
 * wrote the more-entries-than-people line to the diagnostic log at the same
 * rate. Never reporting an unchanged set was wrong the other way (found in
 * review): the words version of the count (once "N online" in the status bar,
 * now the header icon's badge) was overwritten by other paths — a
 * reconnect sets it to "Connected" — and used to be put right by the next caret
 * move, as the circles were re-attached to whichever header is active. The
 * periodic report keeps that repair.
 */
export function presenceReporter(
  awareness: Awareness,
  docName: string,
  report: (people: Person[]) => void,
  now: () => number = Date.now,
): () => void {
  let last: string | null = null;
  let lastAt = -Infinity;
  return () => {
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
    const key = `${awareness.getStates().size}|${peopleKey([...people.values()])}`;
    const at = now();
    const changed = key !== last;
    if (!changed && at - lastAt < PRESENCE_REFRESH_MS) return;
    last = key;
    lastAt = at;

    // Report the raw entries whenever they outnumber the people, which is
    // the only case worth a line. y-codemirror draws one caret per
    // awareness entry while the circles and the status count draw one per
    // person, so this is exactly the gap in which a reader sees a cursor
    // belonging to nobody — a peer that has gone away and not yet been
    // swept, or a subscription of ours that was never torn down. The `age`
    // separates those: a dead peer's entry ages, ours is renewed forever.
    if (changed && awareness.getStates().size > people.size) {
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

    report([...people.values()]);
  };
}

/**
 * How the bind waits for a subscription that may already have happened, or may
 * never happen. Ten half-seconds: long enough to cover an IndexedDB load on a
 * cold start, short enough that a stranded editor recovers before anyone
 * reaches for the mouse.
 */
const SUBSCRIPTION_WAIT_MS = 500;
const SUBSCRIPTION_WAIT_TRIES = 10;

/**
 * What the editor binding needs from the plugin around it.
 *
 * `app` and `registerEvent` for the same reasons as the watcher's: the
 * workspace it follows, and the plugin's event lifetime, which is what stops a
 * listener outliving an unload.
 */
export interface EditorBridgeDeps {
  app: App;
  /** Tie a listener to the plugin's lifetime, so unload really unloads it. */
  registerEvent(ref: EventRef): void;
  /** Path to document id and back. */
  docIndex: DocIndex;
  /** The shared folders mapped into this vault. Read live; mappings change. */
  mappings(): FolderMapping[];
  /** "Share my mouse pointer": whether others see where this person's mouse is. Read live. */
  sharePointer(): boolean;
  /**
   * The recorder of edits made while an editor binds (NEC-159). Registered by
   * the plugin as its own editor extension; the bridge arms and reads it.
   */
  pendingEdits: PendingEdits;
  /** "Show collaborators' mouse pointers": whether this person sees theirs. Read live. */
  showPointers(): boolean;
}

export class EditorBridge {
  private deps: EditorBridgeDeps;
  private contentSync: ContentSync;
  private provider: SyncProvider;
  private username: string;

  /**
   * The name this device broadcasts, fixed when the bridge was built. Not the
   * one in settings: a display name saved since then takes effect on the next
   * connection, and until it does this is the name other people see.
   */
  broadcastName(): string {
    return this.username;
  }

  /**
   * Where to take the view to see a collaborator in the open note, as an
   * offset: their caret, else their mouse pointer (`goToInNote`). Read from
   * their awareness state, which holds both as Yjs relative positions: those
   * survive edits made since they were sent, where a line and column would
   * not. For "go to them" from the presence circles; nothing is sent.
   */
  goToOffsetOf(name: string): { index: number; kind: 'caret' | 'pointer' } | null {
    const text = this.boundText;
    if (!text?.doc || !this.currentDocName) return null;
    const awareness = this.provider.getAwareness(this.currentDocName);
    if (!awareness) return null;
    return goToInNote(awareness.getStates(), awareness.clientID, text, name);
  }
  private wiring: EditorWiring;
  /**
   * The editor the current bind is for. A second pane showing the same file is
   * a different editor, and must be bound in its own right rather than taken
   * for the one already bound (SAFE-D5).
   */
  private currentCm: EditorView | null = null;
  /** Bumped by every bind and unbind, so a bind still awaiting can tell it was overtaken. */
  private bindGeneration = 0;
  /** A bind waiting for its document to sync, so unbinding can drop it. */
  private syncedWait: { event: ProviderEvent; cb: () => void } | null = null;
  /** A pending wait for a document's subscription, so it can be cancelled. */
  private subscriptionWait: { event: ProviderEvent; cb: () => void; timer: TimerHandle } | null = null;
  private currentFile: string | null = null;
  private currentDocName: string | null = null;
  private onPresenceChange: ((people: Person[]) => void) | null = null;
  private awarenessHandler: (() => void) | null = null;
  /** The bound note's pointer extension, so a settings change can redraw it. */
  private pointers: RemotePointers | null = null;
  /** Marks the bound editor while a collaborator's caret arrives; see caretArrivals. */
  private arrivalHandler: (() => void) | null = null;
  private arrivalTimer: number | null = null;
  private arrivalDom: HTMLElement | null = null;
  /** The bound note's text, to turn a collaborator's cursor into an offset. */
  private boundText: Y.Text | null = null;

  constructor(
    deps: EditorBridgeDeps,
    contentSync: ContentSync,
    provider: SyncProvider,
    username: string,
    wiring: EditorWiring,
  ) {
    this.deps = deps;
    this.contentSync = contentSync;
    this.provider = provider;
    this.username = username;
    this.wiring = wiring;
    // The bound editor's state was replaced under it, taking the binding with
    // it. Left alone, ContentSync would go on believing the note bound and sync
    // it from neither side. Unbinding hands it back to disk reconciliation, and
    // binding again restores the editor from the document.
    this.wiring.onLost = () => {
      log.warn('The bound editor lost its collaborative binding; binding it again', {
        docName: this.currentDocName,
      });
      this.unbindCollab();
      this.onActiveLeafChange();
    };
  }

  setPresenceCallback(cb: (people: Person[]) => void): void {
    this.onPresenceChange = cb;
  }

  start(): void {
    const ref = this.deps.app.workspace.on('active-leaf-change', () => {
      this.onActiveLeafChange();
    });
    this.deps.registerEvent(ref);

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
    const renameRef = this.deps.app.vault.on('rename', (file, oldPath) => {
      if (oldPath !== this.currentFile) return;
      if (!(file instanceof TFile)) return;
      this.onActiveLeafChange();
    });
    this.deps.registerEvent(renameRef);

    // The broadcast colour is sampled from the theme at the moment presence is
    // announced, so switching light/dark mid-session would leave everyone else
    // seeing the old theme's value — and the local presence circles reading it
    // back, so a user's own screen would disagree with itself.
    //
    // 'css-change' is Obsidian's signal for exactly this; it also fires for
    // snippet and appearance changes, which is harmless here because
    // re-announcing an unchanged state is a no-op to every reader.
    const themeRef = this.deps.app.workspace.on('css-change', () => {
      this.reannouncePresence();
    });
    this.deps.registerEvent(themeRef);

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

  /**
   * Withdraw this person's pointer from the bound note, after "Share my mouse
   * pointer" is turned off. Without this the last position they sent would stay
   * on everyone else's screen until the next time they moved — which, with
   * sharing off, is never.
   *
   * Same guard as `reannouncePresence`: a null local state advertises nobody,
   * and must stay null.
   */
  clearPointer(): void {
    if (!this.currentDocName) return;
    const awareness = this.provider.getAwareness(this.currentDocName);
    const existing = awareness?.getLocalState();
    if (!awareness || !existing || existing.pointer == null) return;
    awareness.setLocalState({ ...existing, pointer: null });
  }

  /** Redraw collaborators' pointers, after "Show collaborators' mouse pointers" changes. */
  refreshPointers(): void {
    this.pointers?.refresh();
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
    const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);

    if (!view?.file) {
      this.unbindCollab();
      return;
    }

    const filePath = view.file.path;
    const cm = editorViewOf(view);

    // The same file in the same editor: already bound, or binding. The same
    // file in another pane falls through and moves the binding there, because
    // that pane carries nothing until it is bound itself.
    if (filePath === this.currentFile && cm === this.currentCm) return;

    this.unbindCollab();

    // Resolve folder mapping
    const mappings = this.deps.mappings();
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
    const docName = this.deps.docIndex.refSync(sharedFolderId, relativePath);
    if (!docName) {
      void this.deps.docIndex
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
    this.currentCm = cm;
    this.currentDocName = docName;
    this.bindGeneration += 1;

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
    // Whether this bind has been overtaken. A path alone cannot say: two panes
    // of the same note share one, and moving between them starts a new bind
    // for the same path while this one may still be awaiting below. Resuming
    // then would install into the new pane without checking its text, and run
    // a second set of presence handlers that nothing removes.
    const bind = this.bindGeneration;
    const stale = (): boolean => this.currentFile !== filePath || this.bindGeneration !== bind;

    const runInstallCollab = async (): Promise<void> => {
      if (stale()) return;

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
      if (stale()) return;

      const localContent = file ? await this.deps.app.vault.read(file) : '';
      if (stale()) return;

      // Prepared here rather than at the seed below, which must stay
      // synchronous: an `await` between the emptiness check and installing
      // `yCollab` would let a re-entrant bind interleave, and the ordering of
      // that sequence is what keeps binding from truncating a file.
      //
      // Built unconditionally when there is content, because whether it is
      // needed depends on `ytext.length` at the moment of the check, not now.
      const seed: SeedUpdate | null =
        localContent.length > 0 ? await buildSeedUpdate(docName, localContent) : null;
      if (stale()) return;

      // The editor this bind is for, and the only one it may be installed in
      // (SAFE-D5). Without one there is nowhere to bind, and saying so beats
      // announcing presence for a note nobody can type into.
      const boundView = cm;
      if (!boundView) {
        log.warn('This editor has no CodeMirror view to bind; leaving it unbound', { docName });
        this.unbindCollab();
        return;
      }

      // Announce presence. Must be setLocalState, not setLocalStateField:
      // subscriptions start with a null local state so background-synced files
      // do not advertise anyone, and setLocalStateField is a no-op on null.
      //
      // Presence format v1 (`@nectenda/shared` presence.ts). The surface
      // fields start null: a note has no pointer or viewport to share until
      // NEC-92 and NEC-20 write them, and `cursor` stays y-codemirror's own.
      const colors = userColor(this.username);
      awareness.setLocalState({
        v: PRESENCE_VERSION,
        pointer: null,
        viewport: null,
        selection: null,
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

      // Track online users — distinct people, reported only when they change.
      this.awarenessHandler = presenceReporter(awareness, docName, (people) => {
        this.onPresenceChange?.(people);
      });
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
        // Which identity the seed would carry. Two vaults seeding the same words
        // must log the same number here; two different numbers for the same text
        // is the duplication this exists to prevent, caught in a log rather than
        // in a doubled note.
        seedClientId: seed?.clientId ?? null,
      });

      // Seed if ytext is empty, under an identity derived from the content, so
      // that a second vault doing the same thing authors the same operation
      // instead of a second copy of the same words. This path is reached while
      // disconnected, where two vaults duplicate every time rather than
      // occasionally.
      if (ytext.length === 0 && seed) {
        // The file went into the document: the edits that produced it, if the
        // editor made them and Obsidian saved them, must not be replayed too.
        if (applySeed(ytext.doc!, seed, localContent) !== 'already-present') {
          this.deps.pendingEdits.adopted(filePath, localContent);
        }
      }

      // Replay what the user did to the editor during this bind before the
      // document wins (NEC-159, SAFE-B5). Every `await` above is a window in
      // which a keystroke reaches the editor and nothing else — Obsidian has
      // not saved it, so neither the file nor the document has it — and the
      // `setValue` below used to erase it from every vault. Measured at 20 ms
      // between the keystroke and the bind. Waiting to bind is not the answer:
      // SAFE-C1's dead ends record that it drops first keystrokes the other way.
      //
      // The edits are the editor's own transactions, recorded all the while it
      // was unbound (`pending-edits.ts`), not inferred from its text: four
      // versions that inferred them lost a keystroke somewhere. Taken here,
      // synchronously, because the keystroke can land during any await above —
      // and from here until unbinding, yCollab carries the editor's edits.
      // Every pane on this note is handed over, this one first: see `take`.
      const pendings = this.deps.pendingEdits.take(boundView, filePath);
      for (const pending of pendings) {
        const replayed = replayEdits(ytext.doc!, ytext, pending.base, pending.changes);
        const detail = { docName, ...replayed, interrupted: pending.interrupted };
        if (pending.interrupted || !replayed.placed) {
          // The pane was rewritten under its edits, or the document moved too
          // far to place them: keep that pane's text whole as well — its own,
          // from before the rewrite, not the active editor's. Not awaited: the
          // text is captured, and the bind must stay synchronous.
          log.warn('Edits made while the editor bound may not have replayed exactly — backing up the editor', detail);
          void this.contentSync.backupEditorText(docName, pending.kept).catch((err: unknown) => {
            log.error('Could not back up the editor while it bound', { docName, error: String(err) });
          });
        } else if (replayed.inserted > 0 || replayed.deleted > 0) {
          log.debug('Replayed edits made while the editor bound', detail);
        }
      }

      // Set editor to match ytext (source of truth)
      const ytextContent = ytext.toString();
      if (view.editor.getValue() !== ytextContent) {
        view.editor.setValue(ytextContent);
      }

      // Install yCollab — editor and ytext already match
      this.boundText = ytext;
      const collabExtension = yCollab(ytext, awareness);
      const undoKeymap = keymap.of(yUndoManagerKeymap);
      // Installed in the bound editor only (SAFE-D5), so no other pane can
      // draw this note's pointers at its own positions. The check stays as a
      // second line: a pointer anchored in the wrong text is sent to everyone.
      this.pointers = remotePointers(ytext, awareness, {
        sharePointer: () => this.deps.sharePointer(),
        showPointers: () => this.deps.showPointers(),
        isBound: (v) => v === boundView,
      });

      // Ease a collaborator's caret in when it arrives, and only then: the
      // stylesheet animates carets while the editor carries this class.
      this.arrivalDom = boundView.dom ?? null;
      const arrived = caretArrivals(awareness.clientID);
      this.arrivalHandler = () => {
        if (!arrived(awareness.getStates()) || !this.arrivalDom) return;
        this.arrivalDom.classList.add('nectenda-caret-arriving');
        if (this.arrivalTimer !== null) window.clearTimeout(this.arrivalTimer);
        this.arrivalTimer = window.setTimeout(() => {
          this.arrivalDom?.classList.remove('nectenda-caret-arriving');
          this.arrivalTimer = null;
        }, CARET_ARRIVAL_MS);
      };
      awareness.on('change', this.arrivalHandler);
      this.arrivalHandler();

      // Into this editor and no other. Checked, because the next line stops
      // ContentSync reconciling from disk: an editor that did not take the
      // binding would then be synced by nothing, and its edits lost on the next
      // reconnect. Unbinding leaves the document to ContentSync instead.
      if (!this.wiring.bind(boundView, [collabExtension, undoKeymap, this.pointers.extension])) {
        log.warn('Could not install collaborative editing in this editor; leaving it unbound', { docName });
        this.unbindCollab();
        return;
      }

      // Only now does CodeMirror own the document. Until this point ContentSync
      // must keep reconciling disk against the CRDT, or edits made before the
      // document syncs — offline, most obviously — are lost.
      this.contentSync.setEditorBound(docName, true);
    };

    // A synchronous wrapper around it, for two reasons. `awaitSubscription`
    // takes `retry: () => void` and handing it an async function is the
    // misuse the linter names; and the two call sites below are statements,
    // where an unhandled rejection would reach nobody. Deliberately not
    // awaited anywhere — attaching the editor binding is fire-and-forget by
    // design, and making its callers wait would change when the editor
    // becomes usable.
    const installCollab = (): void => {
      void runInstallCollab().catch((err: unknown) => {
        log.warn('Could not attach collaborative editing', { docName, error: String(err) });
      });
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
    // Binding while disconnected keeps the edit. The document is a CRDT: edits
    // land in ytext, the provider records the subscription as having unsent
    // work, and the delta is pushed on the next reconnect.
    //
    // This used to claim more than that — that a disconnected bind cannot
    // duplicate, because the seeding above only fires for a genuinely empty
    // document and a previously synced file comes back from IndexedDB non-empty.
    // The premise is true and the conclusion does not follow: it reasons about
    // one vault. A file *this* device has never synced has nothing in
    // IndexedDB, so two such vaults both fill the document from their own disk,
    // both are right, and Yjs concatenates the two inserts because they carry
    // different client ids. Opening such a note in both vaults while the server
    // is down duplicated it every time, not occasionally. Binding is still the
    // right trade — losing an edit is worse than doubling a note — but the
    // duplication was a defect and not a cost of this decision, and the seed
    // below now carries an identity derived from its content so that two vaults
    // author one operation rather than two copies of the same words.
    //
    // Connected but not yet synced still waits, because there the document
    // really is about to arrive and seeding from a stale disk copy would
    // insert characters the server is holding under different identities.
    if (this.provider.isSynced(docName) || !this.provider.isConnected()) {
      installCollab();
    } else {
      const onSynced = () => {
        this.provider.off(`synced:${docName}`, onSynced);
        if (this.syncedWait?.cb === onSynced) this.syncedWait = null;
        installCollab();
      };
      this.syncedWait = { event: `synced:${docName}`, cb: onSynced };
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
    const timer = window.setInterval(() => {
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
    window.clearInterval(this.subscriptionWait.timer);
    this.subscriptionWait = null;
  }

  private unbindCollab(): void {
    this.cancelSubscriptionWait();
    this.bindGeneration += 1;
    if (this.syncedWait) {
      this.provider.off(this.syncedWait.event, this.syncedWait.cb);
      this.syncedWait = null;
    }
    if (this.currentDocName) {
      // Release awareness handler
      const awareness = this.provider.getAwareness(this.currentDocName);
      if (this.awarenessHandler) {
        if (awareness) awareness.off('change', this.awarenessHandler);
        this.awarenessHandler = null;
      }
      if (this.arrivalHandler) {
        if (awareness) awareness.off('change', this.arrivalHandler);
        this.arrivalHandler = null;
      }
      if (this.arrivalTimer !== null) window.clearTimeout(this.arrivalTimer);
      this.arrivalTimer = null;
      this.arrivalDom?.classList.remove('nectenda-caret-arriving');
      this.arrivalDom = null;

      // Withdraw presence. The document stays subscribed for background sync,
      // so without this a closed file would keep showing our cursor to peers
      // until y-protocols' staleness sweep.
      if (awareness) awareness.setLocalState(null);

      // Release doc back to ContentSync for background sync
      this.contentSync.releaseDoc(this.currentDocName);
      this.currentDocName = null;
      this.currentFile = null;
      this.boundText = null;

      this.pointers = null;
      this.currentCm = null;
      this.wiring.unbind();
      // No note is bound now: the recorder logs every editor's edits again,
      // for the next bind to replay. After the reconfigure, so nothing yCollab
      // still does is logged as typing.
      this.deps.pendingEdits.unbound();
      if (this.onPresenceChange) {
        this.onPresenceChange([]);
      }
    }
  }
}
