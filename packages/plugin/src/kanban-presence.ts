import { log } from './logger';

/**
 * Which card or list of a Kanban board someone is on, and drawing that on
 * everyone else's board (WIRE-098).
 *
 * The Kanban community plugin renders a `.md` file as lanes of cards. It
 * gives a card no id that lasts: every parse of the file makes new random ones.
 * So a card is named the way a person would point at it — the lane it is in
 * and its place in that lane, counted in the order the board draws them — and
 * by `key`, a short hash of its text, which a receiver tries first, because a
 * card added above shifts every position below it.
 *
 * A list — a lane — is named the same way, by its place and by a hash of its
 * title, with no `item`: a press on its header or its empty space is being on
 * the list, as a press on a card is being on the card.
 *
 * All of it is read from the board's rendered DOM by class name, which is the
 * one part of the plugin a stylesheet can rely on too. Nothing here calls into
 * the plugin or changes what it renders beyond a class, a data attribute and a
 * CSS variable on the card. A board whose DOM is not as read draws nothing and
 * says so once; who is on the board still shows in the header.
 */

export const KANBAN_VIEW_TYPE = 'kanban';

const LANE = 'kanban-plugin__lane';
const ITEM = 'kanban-plugin__item';
const TITLE = 'kanban-plugin__item-title';
/** A lane's title, and the element around it, which also holds the count of cards when that is shown. */
const LANE_TITLE_TEXT = 'kanban-plugin__lane-title-text';
const LANE_TITLE = 'kanban-plugin__lane-title';
/** On a card someone else is on: the class every peer focus mark uses, coloured by `--nectenda-peer-color`. */
export const FOCUS_CLASS = 'nectenda-peer-focus';

/** A card, or with no `item` a list, as sent. */
export interface BoardFocus {
  lane: number;
  item?: number;
  key: string;
}

/** What this reads of a DOM element. Structural, so the tests can stand one in. */
export interface BoardEl {
  textContent: string | null;
  closest(selector: string): BoardEl | null;
  querySelectorAll(selector: string): ArrayLike<BoardEl>;
  querySelector(selector: string): BoardEl | null;
  contains(other: BoardEl | null): boolean;
  classList: { add(c: string): void; remove(c: string): void };
  dataset: Record<string, string | undefined>;
  style: { setProperty(k: string, v: string): void; removeProperty(k: string): void };
  /** For "go to": brought into view. */
  scrollIntoView?(options: unknown): void;
}

/**
 * A card's key: FNV-1a over its text, as eight hex digits. Short, because it
 * is sent on every move; a hash, because nothing needs the text itself.
 */
export function cardKey(text: string): string {
  let h = 0x811c9dc5;
  const s = text.trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const lanesOf = (root: BoardEl): BoardEl[] => Array.from(root.querySelectorAll(`.${LANE}`));
const itemsOf = (lane: BoardEl): BoardEl[] => Array.from(lane.querySelectorAll(`.${ITEM}`));

/** Whether a board's DOM is as read: it has lanes. An empty board still has its lanes. */
export function boardShapeKnown(root: BoardEl): boolean {
  return lanesOf(root).length > 0;
}

/**
 * Keys of cards seen before an editor replaced their title. Editing a card
 * swaps its text for an editor, whose text changes with every key; the key
 * sent is the one the card had when the edit began, which is still the text on
 * everyone else's board.
 */
const knownKeys = new WeakMap<object, string>();

/**
 * A list's key: the hash of its title, or while the title is being edited —
 * an editor in its place — the one it had before.
 */
function laneKey(lane: BoardEl): string {
  const title = lane.querySelector(`.${LANE_TITLE_TEXT}`);
  if (title) {
    const key = cardKey(title.textContent ?? '');
    knownKeys.set(lane, key);
    return key;
  }
  return knownKeys.get(lane) ?? cardKey(lane.querySelector(`.${LANE_TITLE}`)?.textContent ?? '');
}

/** The card `target` is in on the board under `root`; else the list it is in; else null. */
export function focusAt(root: BoardEl, target: BoardEl | null): BoardFocus | null {
  const item = target?.closest(`.${ITEM}`) ?? null;
  if (!item || !root.contains(item)) {
    const lane = target?.closest(`.${LANE}`) ?? null;
    if (!lane || !root.contains(lane)) return null;
    const laneIndex = lanesOf(root).indexOf(lane);
    return laneIndex < 0 ? null : { lane: laneIndex, key: laneKey(lane) };
  }
  const lane = item.closest(`.${LANE}`);
  if (!lane) return null;
  const laneIndex = lanesOf(root).indexOf(lane);
  const itemIndex = itemsOf(lane).indexOf(item);
  if (laneIndex < 0 || itemIndex < 0) return null;
  const title = item.querySelector(`.${TITLE}`);
  let key = title ? cardKey(title.textContent ?? '') : knownKeys.get(item);
  if (title && key) knownKeys.set(item, key);
  key ??= cardKey(item.textContent ?? '');
  return { lane: laneIndex, item: itemIndex, key };
}

/**
 * The card a focus names on this board: one whose text has its key, else the
 * card at its lane and position, else none — never a guess at another. A
 * focus with no `item` names a list, found the same way by its title.
 */
export function cardFor(root: BoardEl, focus: BoardFocus): BoardEl | null {
  const lanes = lanesOf(root);
  if (focus.item === undefined) {
    return lanes.find((lane) => laneKey(lane) === focus.key) ?? lanes[focus.lane] ?? null;
  }
  for (const lane of lanes) {
    for (const item of itemsOf(lane)) {
      const title = item.querySelector(`.${TITLE}`);
      if (title && cardKey(title.textContent ?? '') === focus.key) return item;
    }
  }
  return itemsOf(lanes[focus.lane] ?? emptyEl)[focus.item] ?? null;
}

const emptyEl = { querySelectorAll: () => [] } as unknown as BoardEl;

/** One collaborator's card, to draw. */
export interface BoardMark {
  focus: BoardFocus;
  name: string;
  color: string;
}

/**
 * The marks drawn on one board: a class, the person's name in a data
 * attribute and their colour in a CSS variable, on each card or list someone is on.
 * The stylesheet draws the outline and the name tag from those, so redrawing
 * adds no element and cannot set off the board's own DOM watch.
 */
export class BoardMarks {
  private marked = new Set<BoardEl>();
  private warned = false;

  draw(root: BoardEl, marks: BoardMark[]): void {
    this.clear();
    if (marks.length === 0) return;
    if (!boardShapeKnown(root)) {
      if (!this.warned) {
        this.warned = true;
        log.warn('A Kanban board is not drawn as read: showing which card collaborators are on is off for it');
      }
      return;
    }
    // Several people on one card: one outline in the first one's colour, every name in the tag.
    const byCard = new Map<BoardEl, BoardMark[]>();
    for (const m of marks) {
      const card = cardFor(root, m.focus);
      if (!card) continue;
      byCard.set(card, [...(byCard.get(card) ?? []), m]);
    }
    for (const [card, on] of byCard) {
      card.classList.add(FOCUS_CLASS);
      card.dataset.nectendaFocus = on.map((m) => m.name).join(', ');
      card.style.setProperty('--nectenda-peer-color', on[0].color);
      this.marked.add(card);
    }
  }

  clear(): void {
    for (const card of this.marked) {
      card.classList.remove(FOCUS_CLASS);
      delete card.dataset.nectendaFocus;
      card.style.removeProperty('--nectenda-peer-color');
    }
    this.marked.clear();
  }
}
