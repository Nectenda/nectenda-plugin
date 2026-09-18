/**
 * Read a claim off one of this install's own tokens, for display.
 *
 * No signature check: the token was issued to this install and is only being
 * asked what it says about itself — which session it belongs to, so the
 * Signed-in vaults list can tell this vault's row from the others by the one
 * thing that is actually unique to a sign-in. Anything unreadable answers
 * null rather than throwing; a settings pane must not fail on a token.
 */
export function sessionIdFromToken(token: string): string | null {
  const claims = decodeClaims(token);
  const sid = claims?.sid;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

function decodeClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
