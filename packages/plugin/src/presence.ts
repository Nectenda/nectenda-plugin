/**
 * Who is in the document, and what colour they are.
 *
 * ## Why a module rather than a helper in editor-bridge
 *
 * Two clients must independently arrive at the same colour for the same person
 * or the feature is worse than nothing — a collaborator whose caret is teal on
 * their screen and cerise on yours is harder to follow than an unnamed one.
 * That makes this pure arithmetic worth testing on its own, away from anything
 * that needs an editor or a socket.
 *
 * ## The palette is six, and cannot usefully be larger
 *
 * Seats are the Nectenda design system's presence ramp, assigned in its stated
 * order: teal, indigo, damson, cerise, rust, then withy gold. Gold is last on
 * purpose — it is the brand colour, and a screen with one collaborator must not
 * paint that person brand-gold.
 *
 * An earlier version of this file extended the ramp instead of wrapping,
 * reasoning that `% 6` hands the seventh person the first person's colour. It
 * generated further hues by bisecting the largest remaining gap, holding
 * lightness and chroma at the ramp's own values. The arithmetic was right and
 * the conclusion was wrong, in two ways that only measurement exposed.
 *
 * The first is that the extension does not work. Measuring every pair in OKLab,
 * the six are already at the limit: the closest pair sits at 0.058 in dark
 * theme, and adding a seventh colour drops the closest pair to 0.046. Every
 * further seat makes it worse — at sixteen it is 0.021, at thirty-two 0.009.
 * The generator did not extend the palette, it diluted it, and it produced
 * colours *less* distinguishable than the collision it was avoiding.
 *
 * The second is that the ramp was barely ever used. Seats were hashed modulo
 * 4096, so roughly one username in seven hundred landed on one of the six
 * design system colours and everybody else got a generated sliver. Two ordinary
 * users came out 17 degrees apart — 0.033, a third of the ramp's worst pair —
 * which is exactly how this was noticed: they looked the same.
 *
 * So the palette is the six, seats wrap, and two people in seven can share a
 * colour. That is the honest trade and it is the one the design system already
 * assumes: colour is the fast read, the name is the true one, and every caret
 * and every circle carries the name. Two people sharing a colour is legible —
 * you read the label. Two people in colours that are nearly but not quite the
 * same is the failure this had, because it looks like a distinction and is not.
 *
 * ## The hole in the wheel
 *
 * Kept because it explains why no cheap extension is available. Converted to
 * OKLCH the six sit at hues 227, 275, 308, 360, 42, 85, with gaps of 47, 33,
 * 52, 42, 43 degrees — and one gap of 142 running from 85 back round to 227.
 *
 * That hole is the green band, and it is empty deliberately. Green is `vine` in
 * this system and it means *healthy* or *synced*: a person coloured green reads
 * as a status indicator. So the widest opening in the wheel is the one place a
 * new colour may not go, which is most of why six is the ceiling.
 */

/** The design system's ramp. Order matters: gold is last. */
const RAMP_LIGHT = ['#1A6580', '#4A55A0', '#6E4390', '#A33862', '#A34A24', '#7F6118'];
const RAMP_DARK = ['#63B2CC', '#8E96E0', '#B58FD6', '#E28AA9', '#E28A5E', '#D9B65A'];


export const SEAT_COUNT = RAMP_LIGHT.length;

/** The green band no presence colour may enter, in degrees. */
export const VINE_BAND = { from: 85, to: 227 } as const;

/**
 * Stable seat for a person.
 *
 * Hashed from the username rather than assigned by join order, because a colour
 * that changes when somebody else arrives moves under the reader mid-session.
 * This way a person is the same colour in every vault, in every session,
 * forever — and every client computes it without having to agree on anything.
 *
 * Wraps into the six, so roughly one pair in six shares a colour. Accepted
 * rather than worked around: the alternatives are a palette of colours too
 * close to tell apart, which is what this replaced, or assignment by join
 * order, which changes a person's colour when somebody else arrives and moves
 * it under the reader mid-session. The name travels on every caret and every
 * circle, and the design system's rule is that colour is the fast read while
 * the name is the true one.
 */
export function seatFor(username: string): number {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return Math.abs(hash) % SEAT_COUNT;
}

/**
 * The colour for a seat, in the given theme.
 *
 * Always one of the design system's six, verbatim rather than approximated. A
 * seat outside the ramp wraps, which is what `seatFor` already guarantees; the
 * modulo here is for any other caller and keeps the function total.
 */
export function seatColour(seat: number, theme: 'light' | 'dark'): string {
  const ramp = theme === 'dark' ? RAMP_DARK : RAMP_LIGHT;
  return ramp[((seat % SEAT_COUNT) + SEAT_COUNT) % SEAT_COUNT];
}

/**
 * Text colour that reads on a given seat's fill.
 *
 * The ramp's light values are dark enough to carry white; the dark values are
 * light enough to need ink.
 */
export function seatTextColour(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? '#14201B' : '#FFFFFF';
}

/** Up to two initials, for the presence circles. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/**
 * One collaborator, as the editor bridge reports them.
 *
 * `colour` is the value the caret is actually painted with, carried rather than
 * recomputed so a circle and its caret cannot disagree.
 */
export interface Person {
  name: string;
  color: string;
}
