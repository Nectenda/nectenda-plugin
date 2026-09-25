import { MAX_PUSH_BYTES } from '@nectenda/shared';
import type { DocSyncState } from './multiplexed-provider';

/**
 * One note's sync status, as the explorer icons and the note header show it.
 *
 * - `confirmed` — the server has recorded everything this device has written.
 * - `sending`   — something is still on its way, or the catch-up is running.
 * - `offline`   — no connection; anything written waits on this device.
 * - `untracked` — in a shared folder, but not attached to a document yet.
 * - `error`     — an update could not be decrypted (SAFE-D4), or a change is
 *                 too large to send (SAFE-A11).
 */
export type FileSyncStatus = 'confirmed' | 'sending' | 'offline' | 'untracked' | 'error';

/**
 * Whether the server is known to hold everything this device wrote.
 *
 * Every condition has to hold, and each one names a place work can still be:
 * the catch-up not yet run, an update queued or mid-encrypt, a push waiting on
 * a reconnect, the reconnect's delta not yet computed, or a push the server
 * has not acknowledged. The last matters most — a frame handed to the socket
 * is not a frame the server recorded, and it drops some without a word.
 *
 * A false "synchronised" is the one thing this must never say (SAFE-E3): it is
 * how someone closes a laptop, or deletes a vault copy, with an edit still on
 * it. So anything not positively confirmed is not confirmed.
 */
export function isConfirmed(s: DocSyncState): boolean {
  return (
    s.connected
    && s.synced
    && s.pending === 0
    && !s.flushing
    && !s.hasUnsentWork
    && !s.reconciling
    && !s.owesReconcile
    && s.awaitingAck === 0
    && s.decryptGapSeq === null
    && s.oversizedPush === null
  );
}

/**
 * `seeded` is the engine's half: whether the first sync has finished, which
 * includes filling an empty document from the file on disk. The provider can
 * be settled before that — its catch-up done, an empty delta pushed — while
 * the file's content has not entered the document yet, let alone the server.
 */
export function fileSyncStatus(state: DocSyncState | null, seeded = true): FileSyncStatus {
  // Not subscribed: the file is in a shared folder but has no document on a
  // connection yet — still connecting, or waiting for a route.
  if (!state) return 'untracked';
  if (state.decryptGapSeq !== null) return 'error';
  // Before `offline`: reconnecting will not fix it, and the note should say
  // what will.
  if (state.oversizedPush !== null) return 'error';
  if (!state.connected) return 'offline';
  return seeded && isConfirmed(state) ? 'confirmed' : 'sending';
}

/** The words for a status. Colour is never the only signal. */
export function describeStatus(status: FileSyncStatus, state: DocSyncState | null): string {
  switch (status) {
    case 'confirmed':
      return 'Synced — the server has every change from this device';
    case 'sending': {
      if (!state?.synced) return 'Syncing — catching up with the server';
      const waiting = (state.pending > 0 || state.flushing || state.hasUnsentWork || state.reconciling || state.owesReconcile ? 1 : 0)
        + state.awaitingAck;
      return waiting > 1
        ? `Syncing — ${waiting} changes not yet confirmed by the server`
        : 'Syncing — a change is not yet confirmed by the server';
    }
    case 'offline':
      return state && (state.pending > 0 || state.hasUnsentWork || state.owesReconcile)
        ? 'Offline — changes are saved on this device and will sync when you reconnect'
        : 'Offline — will sync when you reconnect';
    case 'untracked':
      return 'Not syncing yet — this note is not connected to the server';
    case 'error':
      if (state && state.decryptGapSeq === null && state.oversizedPush !== null) {
        return `Sync problem — a change in this note is too large to send (${mib(state.oversizedPush)}; `
          + `the limit is ${mib(MAX_PUSH_BYTES)}). It is kept on this device. `
          + 'Split the note or remove the large part, and it syncs by itself.';
      }
      return 'Sync problem — an update could not be decrypted and will be requested again';
  }
}

/** One decimal place, so a change just over the limit does not read as equal to it. */
export function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
