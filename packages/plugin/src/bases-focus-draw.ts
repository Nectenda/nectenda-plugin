import { readPresence } from '@nectenda/shared';
import { focusElement } from './bases-internals';

/**
 * Collaborators' focus drawn on Obsidian's own elements: a Bases cell, row,
 * card or list item (WIRE-096), or a row of a note's Properties panel
 * (WIRE-097). A class and a colour only — never a child element, an attribute
 * Obsidian reads, focus, or an event — so a half-typed property value under
 * the mark is left exactly as it was.
 *
 * The elements are Obsidian's and are recycled as a layout scrolls, so each
 * draw first takes every mark it made last time off again. A mark left behind
 * would put someone on an entry they never touched.
 */

// The class is written out where it is added, so the styles contract test sees it.
const COLOUR_VAR = '--nectenda-peer-color';

export interface FocusMark {
  el: HTMLElement;
  color: string;
}

export class FocusMarks {
  private drawn = new Set<HTMLElement>();

  draw(marks: FocusMark[]): void {
    const next = new Map<HTMLElement, string>();
    for (const m of marks) if (!next.has(m.el)) next.set(m.el, m.color);
    for (const el of this.drawn) {
      if (next.has(el)) continue;
      el.classList.remove('nectenda-peer-focus');
      el.style.removeProperty(COLOUR_VAR);
    }
    for (const [el, color] of next) {
      el.classList.add('nectenda-peer-focus');
      el.style.setProperty(COLOUR_VAR, color);
    }
    this.drawn = new Set(next.keys());
  }

  clear(): void {
    this.draw([]);
  }

  /** What is drawn now, for tests. */
  get size(): number {
    return this.drawn.size;
  }
}

/** A path relative to a shared folder's local root, or null when it lies outside it. */
export function relativeTo(root: string, path: string): string | null {
  if (root === '') return path;
  return path.startsWith(root + '/') ? path.slice(root.length + 1) : null;
}

/** A folder-relative path back under the local root. */
export function underRoot(root: string, rel: string): string {
  return root === '' ? rel : `${root}/${rel}`;
}

/**
 * The marks for everyone else's focus in one base, on the layout shown.
 * Someone on an entry this layout does not draw — scrolled away, filtered out,
 * or a layout this cannot read — is not marked; the header still shows them.
 */
export function basesFocusMarks(
  layout: Record<string, unknown>,
  states: Map<number, unknown>,
  self: number,
  root: string,
): FocusMark[] {
  const marks: FocusMark[] = [];
  for (const [clientId, state] of states) {
    if (clientId === self) continue;
    const p = readPresence(state);
    const view = p?.view;
    if (view?.surface !== 'bases' || !view.focus) continue;
    const el = focusElement(layout, underRoot(root, view.focus.path), view.focus.property);
    if (el) marks.push({ el, color: p?.user?.color ?? 'var(--text-accent)' });
  }
  return marks;
}
