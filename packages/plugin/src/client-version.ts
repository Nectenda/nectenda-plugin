/**
 * Which build of this plugin is talking, and how it says so.
 *
 * Once the plugin is in the community store there are several versions of it
 * live at once, updating at their owners' pace, and the server carries the
 * compatibility burden. It cannot carry it without knowing who is calling, so
 * every request to a Nectenda service names the build: `X-Nectenda-Plugin` on
 * HTTP, and `&v=` on the WebSocket URL, where a header cannot be set.
 *
 * The version is the one in `manifest.json`, substituted at build time by
 * esbuild rather than imported, so the bundle carries a literal and there is
 * one place the number is written down. Under a test runner, where that
 * substitution has not happened, it falls back to a marker no floor will ever
 * accept as a real release.
 */

import { log } from './logger';

declare const __PLUGIN_VERSION__: string | undefined;

/** The version from `manifest.json`, or a development marker. */
export const PLUGIN_VERSION: string =
  typeof __PLUGIN_VERSION__ === 'string' && __PLUGIN_VERSION__ ? __PLUGIN_VERSION__ : '0.0.0';

export const PLUGIN_VERSION_HEADER = 'X-Nectenda-Plugin';

/**
 * `fetch`, with this plugin's version attached.
 *
 * Only for requests to a Nectenda service. Attachments are downloaded
 * straight from object storage with presigned URLs and **no headers at all**,
 * because any extra header turns the request into a CORS preflight the bucket
 * will refuse — so those calls deliberately do not come through here.
 *
 * Both services have to name this header in their
 * `Access-Control-Allow-Headers`, or every request fails preflight with
 * nothing in any log to say why.
 */
export function serverFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(PLUGIN_VERSION_HEADER, PLUGIN_VERSION);
  return fetch(input, { ...init, headers }).then((res) => {
    // Both services mint a request id per call and expose it, so that a
    // person who hits a server error has one string to quote and we can find
    // the same eight characters in the host's logs and in the error tracker.
    // Logged only for a failure: on a healthy call it is noise.
    if (!res.ok) {
      const rid = requestId(res);
      log.warn('Server refused a request', {
        status: res.status,
        ...(rid ? { rid } : {}),
      });
    }
    return res;
  });
}

/**
 * The server's id for one request, if it sent one.
 *
 * Null rather than empty when absent: an older server does not send it, and
 * neither does a proxy that strips unknown headers, so nothing may depend on
 * it being there. Reading it cross-origin needs the server to name it in
 * `Access-Control-Expose-Headers`, which both do.
 */
export function requestId(res: Response): string | null {
  return res.headers.get('X-Request-Id') || null;
}

