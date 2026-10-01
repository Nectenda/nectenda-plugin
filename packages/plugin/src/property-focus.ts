import type { Awareness } from 'y-protocols/awareness';
import { readPresence } from '@nectenda/shared';
import { FocusMarks, relativeTo, type FocusMark } from './bases-focus-draw';

/**
 * Who is on which property of a note's Properties panel (WIRE-097).
 *
 * The panel's inputs are not CodeMirror, so yCollab's caret says nothing while
 * someone types a property: today they show no presence at all. This sends
 * the property this device has focused there, on the note's own awareness, and
 * draws everyone else's on the matching row of every pane showing the note.
 *
 * The panel is Obsidian's DOM, not API: a row is
 * `.metadata-property[data-property-key]`. The e2e contract spec fails by name
 * when that moves. Until then, a row this cannot find is simply not drawn and
 * not sent, which is the fallback: nothing, rather than the wrong row.
 *
 * Drawing is a class and a colour on the row, never focus or an event, so a
 * half-typed value in that row is left exactly as it was. Nothing here writes
 * the note.
 */

const ROW = '.metadata-property';

export interface PropertyFocusDeps {
  /** The note the editor is bound to, and its awareness; null while none is. */
  bound(): { path: string; awareness: Awareness } | null;
  /** The containers of every open pane showing `path`, whose panels are searched. */
  panes(path: string): HTMLElement[];
  /** The local root of the shared folder a path is in, or null. */
  folderRoot(path: string): string | null;
  /** The element with focus now. */
  activeElement(): Element | null;
}

/** The property row an element is in, and its key, or null. */
function rowOf(el: Element | null): { row: Element; key: string } | null {
  const row = el?.closest<HTMLElement>(ROW);
  const key = row?.dataset.propertyKey;
  return row && key ? { row, key } : null;
}

export class PropertyFocus {
  private marks = new FocusMarks();
  private watched: { awareness: Awareness; onChange: () => void } | null = null;
  private soon: number | null = null;

  constructor(private deps: PropertyFocusDeps) {}

  /** For focusin and focusout: look again once focus has settled where it was going. */
  later(): void {
    if (this.soon !== null) return;
    this.soon = window.setTimeout(() => {
      this.soon = null;
      this.sync();
    }, 0);
  }

  /** Send this device's focus if it moved, and redraw everyone else's. */
  sync(): void {
    const bound = this.deps.bound();
    this.watch(bound?.awareness ?? null);
    if (bound) this.send(bound);
    this.draw();
  }

  /** Redraw only: the panel was rebuilt (a property changed), or someone moved. */
  draw(): void {
    const bound = this.deps.bound();
    const root = bound ? this.deps.folderRoot(bound.path) : null;
    const rel = bound && root !== null ? relativeTo(root, bound.path) : null;
    if (!bound || rel === null) {
      this.marks.clear();
      return;
    }
    const keys = new Map<string, string>();
    for (const [clientId, state] of bound.awareness.getStates()) {
      if (clientId === bound.awareness.clientID) continue;
      const p = readPresence(state);
      // Only a focus on this very note: another's would be on the wrong panel.
      if (p?.view?.surface !== 'properties' || p.view.focus.path !== rel) continue;
      if (!keys.has(p.view.focus.property)) keys.set(p.view.focus.property, p.user?.color ?? 'var(--text-accent)');
    }
    const marks: FocusMark[] = [];
    if (keys.size > 0) {
      for (const pane of this.deps.panes(bound.path)) {
        for (const row of Array.from(pane.querySelectorAll<HTMLElement>(ROW))) {
          const color = row.dataset.propertyKey ? keys.get(row.dataset.propertyKey) : undefined;
          if (color) marks.push({ el: row, color });
        }
      }
    }
    this.marks.draw(marks);
  }

  dispose(): void {
    if (this.soon !== null) window.clearTimeout(this.soon);
    this.soon = null;
    this.watch(null);
    this.marks.clear();
  }

  private send(bound: { path: string; awareness: Awareness }): void {
    const local = bound.awareness.getLocalState() as { view?: unknown } | null;
    // A null state advertises nobody (a background document); keep it so.
    if (!local) return;
    const root = this.deps.folderRoot(bound.path);
    const rel = root === null ? null : relativeTo(root, bound.path);
    const at = rowOf(this.deps.activeElement());
    const inPane = at !== null && this.deps.panes(bound.path).some((pane) => pane.contains(at.row));
    const view = rel !== null && at && inPane ? { surface: 'properties', focus: { path: rel, property: at.key } } : null;
    // Compared with what the state says now, not with what was last sent: the
    // bridge replaces the whole state when it binds again.
    if (JSON.stringify(local.view ?? null) === JSON.stringify(view)) return;
    bound.awareness.setLocalStateField('view', view);
  }

  private watch(awareness: Awareness | null): void {
    if (this.watched?.awareness === awareness) return;
    if (this.watched) this.watched.awareness.off('change', this.watched.onChange);
    this.watched = null;
    if (!awareness) return;
    const onChange = (): void => this.draw();
    awareness.on('change', onChange);
    this.watched = { awareness, onChange };
  }
}
