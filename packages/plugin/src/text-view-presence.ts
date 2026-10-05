import type { Awareness } from 'y-protocols/awareness';
import { PRESENCE_VERSION, readPresence } from '@nectenda/shared';
import { presenceReporter } from './editor-bridge';
import type { Person } from './presence';
import { log } from './logger';
import { BoardMarks, KANBAN_VIEW_TYPE, cardFor, focusAt, type BoardEl, type BoardFocus, type BoardMark } from './kanban-presence';

/**
 * Who is on a note that another plugin's view shows — a board of the Kanban
 * plugin, or any TextFileView of a `.md` that is not Obsidian's editor
 * (WIRE-098).
 *
 * Obsidian's editor reports presence through its CodeMirror binding
 * (editor-bridge.ts); a view like this has none, and nothing binds it to the
 * document — disk stays the only writer, guarded by text-view-guard.ts — so
 * this holds the note's awareness only to say who is here. While such a view
 * is active, this device says it is on the note in that view, and the people
 * on the note — in this kind of view or in their own editor — are reported
 * for the view header, which `renderPresenceStack` draws into whichever
 * TextFileView is active. A view type this build has never heard of is
 * covered the same way.
 *
 * On a Kanban board, finer than the note, `focus` names the card this device
 * is on — editing, holding the pointer down on, or last clicked — or the list
 * when the click was on a list but no card, and everyone else's is outlined in
 * their colour (kanban-presence.ts). Only Kanban: other views send and draw no
 * focus.
 *
 * A click is kept, not just the press. Clicking a card puts the focus nowhere
 * — Kanban opens no editor for it — so a card named only while focused or
 * pressed flashed on the other board for as long as the button was held and
 * was gone on release (found testing in two vaults). It is now this device's
 * card until a press lands on the board outside every list, Escape is pressed,
 * or the view stops being the active one.
 *
 * Only the active view speaks, as with the editor: a person is in one place at
 * a time, and leaving it clears the state at once (WIRE-092) — but only a
 * state this wrote, so going from a board to the same note's editor never
 * clears what the editor has just said.
 */

/** What this needs of an open view of a note. */
export interface NoteViewLike {
  file: { path: string } | null;
  getViewType(): string;
  /** The view's element: where its focus and pointer events are heard, and its board drawn. */
  containerEl: BoardEl & EventHost;
}

interface EventHost {
  addEventListener(type: string, fn: (e: { target: unknown }) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (e: { target: unknown }) => void, capture?: boolean): void;
}

export interface TextViewPresenceDeps {
  /** The active view, if it is another plugin's view of a shared note; else null. */
  active(): NoteViewLike | null;
  /** The note's document and its awareness, if it is synced and subscribed. */
  awarenessFor(path: string): { docName: string; awareness: Awareness } | null;
  username(): string;
  userColor(name: string): { seat: number; color: string; light: string };
  /** Who is here, for the header of the active view. Only called while one is active. */
  report(people: Person[]): void;
  /** Where the document's focus is now. */
  activeElement(): unknown;
  /**
   * Whether a Kanban board sends and draws card focus ("Live sync for Kanban
   * boards", NEC-200). Off, the person is still shown in the header. Absent: on.
   */
  kanbanFocus?(): boolean;
}

interface Held {
  view: NoteViewLike;
  docName: string;
  awareness: Awareness;
  onChange: () => void;
  onDestroy: () => void;
  /** The view and focus last sent, so an unchanged one is not re-sent (WIRE-091). */
  sent: string | null;
  stop: () => void;
}

export const NOTE_VIEW_SURFACE = 'note-view';

export class TextViewPresence {
  /** A Kanban board, with card focus switched on (NEC-200). */
  private boardFocus(view: NoteViewLike): boolean {
    return view.getViewType() === KANBAN_VIEW_TYPE && (this.deps.kanbanFocus?.() ?? true);
  }

  private held: Held | null = null;
  private marks = new BoardMarks();
  /** Where the pointer went down in the held view, until it comes up. */
  private pressed: BoardEl | null = null;
  /**
   * The card last clicked or dropped in the held view, until the person moves
   * on. Kept as a focus, not an element: Kanban redraws a card on every change
   * to the board, and the card a drag ends on is not the element it began on.
   */
  private selected: BoardFocus | null = null;
  private soon: number | null = null;

  constructor(private deps: TextViewPresenceDeps) {}

  /**
   * Bring presence in line with the active view: hold its note's awareness and
   * say this device is there, or let go. Called on layout and active-leaf
   * changes and on a tick; cheap and idempotent.
   */
  refresh(): void {
    const view = this.deps.active();
    const path = view?.file?.path ?? null;
    const got = path ? this.deps.awarenessFor(path) : null;
    if (!view || !got) {
      this.leave();
      return;
    }
    if (this.held?.view !== view || this.held.awareness !== got.awareness) {
      this.leave();
      this.enter(view, got.docName, got.awareness);
    }
    this.publish();
    this.draw();
  }

  private enter(view: NoteViewLike, docName: string, awareness: Awareness): void {
    const reporter = presenceReporter(awareness, docName, (people) => this.deps.report(people));
    const onChange = (): void => {
      reporter();
      this.draw();
    };
    // The provider destroys a note's awareness when it disconnects the file
    // even while the view stays open: let go, so the next refresh holds
    // whatever reconnects rather than speaking into a dead one.
    const onDestroy = (): void => {
      if (this.held?.awareness === awareness) this.leave();
    };
    awareness.on('change', onChange);
    awareness.on('destroy', onDestroy);
    const stop = this.listen(view);
    this.held = { view, docName, awareness, onChange, onDestroy, sent: null, stop };
    // A fresh reporter always reports: the header was cleared by whatever was active before.
    presenceReporter(awareness, docName, (people) => this.deps.report(people))();
  }

  /**
   * Listen on the view for what moves this device's card — focus going into
   * or out of a card editor, the pointer going down on a card or coming up —
   * and on a Kanban board, for the board re-rendering, which redraws the marks.
   */
  private listen(view: NoteViewLike): () => void {
    if (!this.boardFocus(view)) return () => undefined;
    const host = view.containerEl;
    const later = (): void => this.later();
    // Which card a press began on, read as it goes down: by the time it comes
    // up a drag may have redrawn the card, and the element is gone.
    let pressedOn: BoardFocus | null = null;
    const down = (e: { target: unknown }): void => {
      this.pressed = e.target as BoardEl;
      pressedOn = focusAt(host, this.pressed);
      // A press on the board but on no card or list is moving on from the one clicked.
      if (pressedOn === null) this.selected = null;
      later();
    };
    const up = (e: { type?: string }): void => {
      if (this.pressed === null) return;
      this.pressed = null;
      // A cancelled press selected nothing; a release or a drop did.
      if (pressedOn !== null && e.type !== 'pointercancel') this.selected = pressedOn;
      pressedOn = null;
      later();
    };
    const key = (e: { target: unknown; key?: string }): void => {
      if (e.key !== 'Escape' || this.selected === null) return;
      this.selected = null;
      later();
    };
    const on: [string, (e: { target: unknown; type?: string; key?: string }) => void][] = [
      ['focusin', later], ['focusout', later], ['pointerdown', down], ['pointerup', up], ['pointercancel', up],
      ['dragend', up], ['drop', up],
    ];
    for (const [type, fn] of on) host.addEventListener(type, fn, true);
    // Escape on the view's whole document, not only inside it: a click on a
    // card leaves the keyboard focus wherever it was, often outside the view.
    // Only the active view is held, so it is the one being spoken to.
    const keys = (host as { ownerDocument?: EventHost | null }).ownerDocument ?? host;
    keys.addEventListener('keydown', key, true);
    // Kanban re-renders a card on every change to the board, and a mark drawn
    // on the card it replaced is gone. `childList` only: the marks are a class,
    // a data attribute and a style property, so drawing cannot set this off.
    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      // The card this device is on moves too, so its place is sent again; an
      // unchanged one is not (WIRE-091).
      observer = new MutationObserver(() => {
        this.draw();
        this.later();
      });
      observer.observe(host as unknown as Node, { childList: true, subtree: true });
    }
    return () => {
      for (const [type, fn] of on) host.removeEventListener(type, fn, true);
      keys.removeEventListener('keydown', key, true);
      observer?.disconnect();
    };
  }

  /** Refresh once, after the event that asked has been handled by Obsidian and the editor bridge too. */
  later(): void {
    if (this.soon !== null) return;
    this.soon = window.setTimeout(() => {
      this.soon = null;
      this.refresh();
    }, 0);
  }

  /** The card this device is on in the held view, or null. */
  private localFocus(view: NoteViewLike): BoardFocus | null {
    if (!this.boardFocus(view)) return null;
    const root = view.containerEl;
    const active = this.deps.activeElement() as BoardEl | null;
    if (active && root.contains(active)) {
      const at = focusAt(root, active);
      if (at) return at;
    }
    if (this.pressed && root.contains(this.pressed)) {
      const at = focusAt(root, this.pressed);
      if (at) return at;
    }
    if (this.selected === null) return null;
    // Found again as a receiver would find it: by its text, else its place.
    // Then read afresh, so a card moved or retyped is sent where it is now.
    const card = cardFor(root, this.selected);
    const at = card ? focusAt(root, card) : null;
    this.selected = at;
    return at;
  }

  private isOurs(awareness: Awareness): boolean {
    const local = awareness.getLocalState() as { view?: { surface?: unknown } } | null;
    return local?.view?.surface === NOTE_VIEW_SURFACE;
  }

  private publish(): void {
    const held = this.held;
    if (!held) return;
    const type = held.view.getViewType();
    const focus = this.localFocus(held.view);
    const key = JSON.stringify([type, focus]);
    // Re-sent if something else — the editor letting go of the note — cleared it since.
    if (held.sent === key && this.isOurs(held.awareness)) return;
    held.sent = key;
    log.debug('Note view presence sent', { docName: held.docName, type, focus: focus !== null });
    const name = this.deps.username();
    const c = this.deps.userColor(name);
    held.awareness.setLocalState({
      v: PRESENCE_VERSION,
      user: { name, seat: c.seat, color: c.color, colorLight: c.light },
      cursor: null, pointer: null, viewport: null, selection: null, gesture: null,
      view: { surface: NOTE_VIEW_SURFACE, type, ...(focus ? { focus } : {}) },
    });
  }

  /** Outline everyone else's card on the held board. */
  draw(): void {
    const held = this.held;
    if (!held || !this.boardFocus(held.view)) {
      this.marks.clear();
      return;
    }
    const marks: BoardMark[] = [];
    for (const [clientId, state] of held.awareness.getStates()) {
      if (clientId === held.awareness.clientID) continue;
      const p = readPresence(state);
      const view = p?.view;
      if (!p?.user || view?.surface !== NOTE_VIEW_SURFACE || view.type !== KANBAN_VIEW_TYPE || !view.focus) continue;
      marks.push({ focus: view.focus, name: p.user.name, color: p.user.color });
    }
    this.marks.draw(held.view.containerEl, marks);
  }

  /** Let go of the held note: stop listening, clear the marks, and clear this device's state if it is still ours. */
  private leave(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    this.pressed = null;
    this.selected = null;
    held.stop();
    this.marks.clear();
    held.awareness.off('change', held.onChange);
    held.awareness.off('destroy', held.onDestroy);
    if (!this.isOurs(held.awareness)) return;
    // Gone at once, not after the 30 s awareness timeout (WIRE-092).
    try {
      held.awareness.setLocalState(null);
    } catch (err) {
      log.debug('Could not clear presence for a note view', { docName: held.docName, error: String(err) });
    }
  }

  /**
   * Bring the card `name` is on into view, for "go to". False when they are on
   * no card of the active board that this board draws.
   */
  goTo(name: string): boolean {
    const held = this.held;
    if (!held || !this.boardFocus(held.view)) return false;
    for (const [clientId, state] of held.awareness.getStates()) {
      if (clientId === held.awareness.clientID) continue;
      const p = readPresence(state);
      const view = p?.view;
      if (p?.user?.name !== name || view?.surface !== NOTE_VIEW_SURFACE || !view.focus) continue;
      const card = cardFor(held.view.containerEl, view.focus);
      if (!card) continue;
      card.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.soon !== null) window.clearTimeout(this.soon);
    this.soon = null;
    this.leave();
  }
}
