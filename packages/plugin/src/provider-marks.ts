/**
 * The sign-in providers as buttons: each one's mark, its label, and the URL
 * that starts its flow directly, so the settings tab offers "Google",
 * "Microsoft" and "Apple" rather than one "continue in browser" that lands
 * on a chooser page.
 *
 * The artwork is the same in all three places a customer meets it: these
 * paths are the ones the sign-in page serves, so the settings tab, the web
 * page and the design handover show one Google G rather than three. Google's
 * is its four-colour mark, which is the only form its brand terms allow on a
 * sign-in button; Apple's is drawn in the current text colour so it sits on
 * either theme, and Microsoft's four squares carry their own colours.
 */
export type ProviderName = 'google' | 'microsoft' | 'apple';

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
};

/** The order the sign-in mockups set, and the order the web page uses. */
export const PROVIDER_ORDER: ProviderName[] = ['google', 'apple', 'microsoft'];

/** Where a browser flow for one provider begins; the plugin opens this instead of the chooser page. */
export function providerStartUrl(baseUrl: string, provider: ProviderName, nonce: string): string {
  return `${baseUrl.replace(/\/$/, '')}/auth/provider/${provider}/start?nonce=${encodeURIComponent(nonce)}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(viewBox: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('width', '18');
  el.setAttribute('height', '18');
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('nectenda-provider-mark');
  return el;
}

function path(d: string, fill: string): SVGPathElement {
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('d', d);
  el.setAttribute('fill', fill);
  return el;
}

function rect(x: number, y: number, fill: string): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('width', '10');
  el.setAttribute('height', '10');
  el.setAttribute('fill', fill);
  return el;
}

/**
 * Google's mark is four paths, one per colour, on a 48-unit grid. It is not
 * the monochrome simple-icons G: Google's own guidelines require the full
 * colour mark on a sign-in control, and the page a customer sees before this
 * one already shows it.
 */
const GOOGLE_PATHS: Array<[string, string]> = [
  ['#4285F4', 'M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z'],
  ['#34A853', 'M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z'],
  ['#FBBC05', 'M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z'],
  ['#EA4335', 'M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z'],
];

/** Two paths: the body and the leaf, both in the current text colour. */
const APPLE_PATHS = [
  'M17.05 12.54c-.03-2.73 2.23-4.04 2.33-4.1-1.27-1.86-3.25-2.11-3.95-2.14-1.68-.17-3.28.99-4.13.99-.85 0-2.17-.97-3.56-.94-1.83.03-3.52 1.06-4.46 2.7-1.9 3.3-.49 8.19 1.36 10.87.9 1.31 1.98 2.78 3.4 2.73 1.36-.05 1.88-.88 3.53-.88 1.65 0 2.11.88 3.55.85 1.47-.02 2.4-1.34 3.3-2.65 1.04-1.52 1.47-2.99 1.49-3.07-.03-.01-2.86-1.1-2.89-4.36z',
  'M14.6 4.6c.75-.91 1.25-2.17 1.11-3.43-1.08.04-2.38.72-3.15 1.63-.69.8-1.29 2.09-1.13 3.32 1.2.09 2.43-.61 3.17-1.52z',
];

/** The four squares, on the same 24-unit grid as the others. */
const MICROSOFT_SQUARES: Array<[number, number, string]> = [
  [1, 1, '#F25022'],
  [13, 1, '#7FBA00'],
  [1, 13, '#00A4EF'],
  [13, 13, '#FFB900'],
];

/** A fresh element each call: an SVG node can live in one place only. */
export function providerMark(provider: ProviderName): SVGSVGElement {
  switch (provider) {
    case 'google': {
      const el = svg('0 0 48 48');
      for (const [fill, d] of GOOGLE_PATHS) el.appendChild(path(d, fill));
      return el;
    }
    case 'apple': {
      const el = svg('0 0 24 24');
      for (const d of APPLE_PATHS) el.appendChild(path(d, 'currentColor'));
      return el;
    }
    case 'microsoft': {
      const el = svg('0 0 24 24');
      for (const [x, y, fill] of MICROSOFT_SQUARES) el.appendChild(rect(x, y, fill));
      return el;
    }
  }
}
