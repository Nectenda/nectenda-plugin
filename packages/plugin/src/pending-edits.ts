import { ChangeSet, Transaction, type EditorState, type Text } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { ySyncAnnotation } from 'y-codemirror.next';

/**
 * What the user did to an editor while it was not bound to its document
 * (NEC-159, SAFE-B5).
 *
 * Binding is asynchronous and ends by setting the editor from the document. A
 * keystroke typed in between is in the editor and nowhere else, and used to be
 * erased from every vault. Four attempts to recover it by comparing the
 * editor's text with the file and the document each lost a keystroke in some
 * state, because at the level of characters "typed" and "shown but not yet
 * reloaded" can be the same string. CodeMirror does not have to guess: it
 * knows which transactions changed the editor. This records them.
 *
 * **Recording is continuous, not armed at the bind.** Obsidian fires
 * `active-leaf-change` after `setActiveLeaf` returns — measured in Obsidian on
 * 30 September 2026, with the keystroke landing between the two — so anything
 * started from that event starts after the key it exists to catch. Instead
 * every editor keeps a log of its edits from the last point it matched its
 * note — loaded or reloaded from disk — and the bind takes the log.
 *
 * **Never for the editor that is bound.** Its edits reach the document through
 * yCollab, the only extension that carries them (SAFE-D5).
 *
 * **Every other pane is logged, a second pane on the bound note included.**
 * Obsidian mirrors that pane's typing into the bound one, tagged `set`, and
 * yCollab publishes it from there — *if* the bound pane is still bound when
 * the mirror lands. It was not, in the e2e run that found this: the key typed
 * into the second pane as it activated reached neither vault, because the
 * binding had moved and the pane was then set from the document. So the second
 * pane keeps its log, and whatever the bound editor takes in is cut from the
 * logs on its note, as a save is (`adopted`). A mirror that arrived in time is
 * cut and not replayed twice; one that did not is replayed at the bind.
 *
 * Registered once, on its own: it watches every editor, and the binding is
 * installed in one.
 */
export interface Pending {
  /** The editor's text where the log starts. */
  base: string;
  /** Everything recorded since, as one change set from `base`. */
  changes: ChangeSet;
  /**
   * The editor was rewritten under recorded edits — a reload from disk, or an
   * edit mirrored in from another pane on the same file, which Obsidian also
   * tags `set` (measured) — so what came before it cannot be replayed against
   * `base`. The caller keeps `kept` in a backup.
   */
  interrupted: boolean;
  /**
   * The text worth backing up for this pane: what it held just before it was
   * first rewritten under recorded edits, since that is where those edits are,
   * or else what it holds now.
   */
  kept: string;
}

interface Step {
  changes: ChangeSet;
  after: Text;
}

interface Log {
  path: string | null;
  base: Text;
  steps: Step[];
  interrupted: boolean;
  /** What the editor held just before it was first rewritten under logged edits. */
  lostText: string | null;
}

/**
 * Whether a transaction is the user's (or a plugin's) edit.
 *
 * Measured in Obsidian on 30 September 2026, not assumed: typing carries
 * `userEvent` `input.type`, Backspace `delete.backward`, and
 * `editor.replaceRange` none at all — those are edits. Obsidian loading or
 * reloading the file carries `set`, and so does `editor.setValue`, which is how
 * the bind itself rewrites the editor: a change the file already has. And
 * yCollab's own transactions carry `ySyncAnnotation`: a change the document
 * already has.
 */
export function admits(tr: Transaction): boolean {
  return (
    tr.docChanged &&
    tr.annotation(Transaction.userEvent) !== 'set' &&
    tr.annotation(ySyncAnnotation) === undefined
  );
}

export class PendingEdits {
  private logs = new Map<object, Log>();
  /** The editor bound now, whose edits yCollab carries, and the note it shows. */
  private bound: { key: object; path: string | null } | null = null;

  /** `pathOf` names the note an editor shows; the plugin reads it from Obsidian. */
  constructor(private readonly pathOf: (state: EditorState) => string | null = () => null) {}

  /** For `registerEditorExtension`. */
  readonly extension = (() => {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the view plugin class below needs this recorder, not its own instance
    const rec = this;
    return ViewPlugin.fromClass(
      class {
        constructor(private readonly view: EditorView) {}
        update(u: ViewUpdate): void {
          if (u.docChanged) rec.record(u.view, u.startState.doc, u.transactions, rec.pathOf(u.state));
        }
        destroy(): void {
          rec.forget(this.view);
        }
      },
    );
  })();

  /**
   * An editor is being bound to the note at `path`. Hands over what was logged
   * for that note — this editor's log first, then any other pane's on the same
   * note, each against its own base — and stops logging this editor until
   * `unbound`. Those logs are then discarded: a log kept across the bind would
   * describe text the pane no longer shows (a stale base deleted a
   * collaborator's character in review). Another pane on the note starts a
   * fresh log from its next change.
   *
   * Never throws: a bind that failed here would leave the editor unbound and
   * the note unlogged. A log that cannot be composed is handed over as
   * interrupted, so the caller backs the editor up instead.
   */
  take(key: object, path: string | null): Pending[] {
    this.bound = { key, path };
    const logs: Log[] = [];
    const own = this.logs.get(key);
    if (own) logs.push(own);
    this.logs.delete(key);
    if (path !== null) {
      for (const [k, log] of this.logs) {
        if (log.path !== path) continue;
        logs.push(log);
        this.logs.delete(k);
      }
    }
    const out: Pending[] = [];
    for (const log of logs) {
      const base = log.base.toString();
      const now = log.steps.length > 0 ? log.steps[log.steps.length - 1].after.toString() : base;
      const kept = log.lostText ?? now;
      if (log.steps.length === 0) {
        if (log.interrupted) out.push({ base, changes: ChangeSet.empty(log.base.length), interrupted: true, kept });
        continue;
      }
      try {
        out.push({
          base,
          changes: log.steps.map((s) => s.changes).reduce((a, b) => a.compose(b)),
          interrupted: log.interrupted,
          kept,
        });
      } catch {
        out.push({ base, changes: ChangeSet.empty(log.base.length), interrupted: true, kept });
      }
    }
    return out;
  }

  /** No editor is bound: every editor is logged again, from its next edit. */
  unbound(): void {
    this.bound = null;
  }

  forget(key: object): void {
    this.logs.delete(key);
  }

  /**
   * `text` has just been taken into the note at `path` from its file — by the
   * sync path, or by a seed filling an empty document. Any editor on that note
   * that held exactly `text` after one of its logged edits was saved then, so
   * everything up to that edit is in the document now and must not be
   * replayed again: Obsidian's debounced save, taken in from disk and replayed
   * by the bind as well, typed it twice (`R1R1`, seen in Obsidian). Every path
   * that fills a document from a file reports here; an earlier version guessed
   * from the document's text instead, and a collaborator typing the same text
   * by coincidence made it drop edits the document never had.
   *
   * Scoped to the note: another note with the same text says nothing about
   * this one.
   */
  adopted(path: string, text: string): void {
    for (const log of this.logs.values()) {
      if (log.path === path) cut(log, text);
    }
  }

  /** The core, apart from CodeMirror's view, so it can be tested with state alone. */
  record(key: object, startDoc: Text, transactions: readonly Transaction[], path: string | null = null): void {
    // The bound editor: yCollab carries its edits, so nothing is logged. A
    // `set` that is not yCollab's own — Obsidian's mirror of another pane on
    // the note, or a reload — has just been published, so that pane drops
    // what led up to that exact text. The recorder cannot tell a mirror from a
    // reload, and need not: either way the document now reads it. Never cut on
    // yCollab's transactions: a collaborator's edit can make the text read
    // like an old state of the pane by coincidence, and cutting there would
    // drop edits the document never had.
    //
    // Showing another note than the one bound — a file opened into the bound
    // leaf, in the moment before the bridge unbinds — it is logged like any
    // other editor. yCollab may carry that edit too, and a duplicate is
    // visible; an edit logged nowhere would be erased by the next bind.
    if (this.bound && key === this.bound.key && path !== null && path === this.bound.path) {
      for (const tr of transactions) {
        if (!mirrored(tr)) continue;
        const text = tr.newDoc.toString();
        for (const [k, log] of this.logs) {
          if (k !== key && log.path === path) cut(log, text);
        }
      }
      return;
    }
    let log = this.logs.get(key);
    if (!log || log.path !== path) {
      // A new editor, or one now showing another note: start from here.
      log = { path, base: startDoc, steps: [], interrupted: false, lostText: null };
      this.logs.set(key, log);
    }
    for (const tr of transactions) {
      if (!tr.docChanged) continue;
      if (admits(tr)) {
        log.steps.push({ changes: tr.changes, after: tr.newDoc });
        continue;
      }
      // A load, a reload or yCollab: the editor now shows what its note has.
      // Edits logged before it cannot be expressed against the new text.
      if (log.steps.length > 0) {
        log.interrupted = true;
        log.lostText ??= tr.startState.doc.toString();
      }
      log.base = tr.newDoc;
      log.steps = [];
    }
  }
}

/** Another pane's edit copied in by Obsidian: a rewrite that is not yCollab's. */
function mirrored(tr: Transaction): boolean {
  return (
    tr.docChanged &&
    tr.annotation(Transaction.userEvent) === 'set' &&
    tr.annotation(ySyncAnnotation) === undefined
  );
}

/** Drop the steps up to the last one after which the editor read `text`. */
function cut(log: Log, text: string): void {
  for (let i = log.steps.length - 1; i >= 0; i--) {
    const after = log.steps[i].after;
    if (after.length === text.length && after.toString() === text) {
      log.base = after;
      log.steps = log.steps.slice(i + 1);
      return;
    }
  }
}
