import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { TrackedDoc } from './content-sync';
import type { DocSyncState } from './multiplexed-provider';
import { describeStatus, fileSyncStatus, type FileSyncStatus } from './sync-status';

export const INSPECTOR_VIEW = 'nectenda-sync-inspector';

export interface InspectorDeps {
  trackedDocs(): TrackedDoc[];
  docSyncState(docName: string): DocSyncState | null;
  /** Read from disk now. Null when it cannot be read. */
  diskMatchesDocument(docName: string): Promise<boolean | null>;
  /** Whether a path is inside a shared folder at all. */
  inSharedFolder(path: string): boolean;
}

export type Row = [label: string, value: string];

export interface NoteReport {
  path: string;
  status: FileSyncStatus | null;
  summary: string;
  rows: Row[];
}

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

/**
 * Everything the plugin believes about one note, and one thing it checks.
 *
 * The belief is read from the engine and the provider as they stand. The check
 * is the file on disk, read now and compared with the document: the one claim
 * here that is observed rather than remembered, which is the point of an
 * inspector (CLAUDE.md, "Verifying claims"). It only reads.
 */
export async function inspectNote(deps: InspectorDeps, path: string): Promise<NoteReport> {
  if (!deps.inSharedFolder(path) || !path.endsWith('.md')) {
    return {
      path,
      status: null,
      summary: 'Not synced by Nectenda — this note is outside every shared folder.',
      rows: [],
    };
  }
  const doc = deps.trackedDocs().find((d) => d.localPath === path);
  if (!doc) {
    return {
      path,
      status: 'untracked',
      summary: describeStatus('untracked', null),
      rows: [['Attached to a document', 'no']],
    };
  }
  const state = doc.placed ? deps.docSyncState(doc.docName) : null;
  const status = fileSyncStatus(state, doc.hasSyncedOnce);
  const disk = await deps.diskMatchesDocument(doc.docName);
  const rows: Row[] = [
    ['Document', doc.docName],
    ['Shared folder', doc.sharedFolderId],
    ['Placed on a connection', yesNo(doc.placed)],
    ['Open in an editor', yesNo(doc.editorActive)],
    ['Confirmed by the server at least once', yesNo(doc.hasSyncedOnce)],
    ['First-sync check done', yesNo(doc.firstSyncChecked)],
    ['Cached on this device at connect', yesNo(doc.idbHadData)],
    ['Write to disk pending', yesNo(doc.diskWritePending)],
    ['File on disk matches the document', disk === null ? 'could not read' : yesNo(disk)],
  ];
  if (state) {
    rows.push(
      ['Connected', yesNo(state.connected)],
      ['Caught up with the server', yesNo(state.synced)],
      ['Changes queued to send', String(state.pending)],
      ['Sending now', yesNo(state.flushing)],
      ['Waiting for a reconnect', yesNo(state.hasUnsentWork)],
      ['Reconciling after reconnect', yesNo(state.reconciling)],
      ['Owes the server a full reconcile', yesNo(state.owesReconcile)],
      ['Sent, not yet confirmed', String(state.awaitingAck)],
      ['Read position', String(state.lastSeq)],
      ['Snapshot covers', String(state.snapshotSeq)],
      ['Undecryptable update', state.decryptGapSeq === null ? 'none' : `at ${state.decryptGapSeq}`],
      ['Change too large to send', state.oversizedPush === null ? 'none' : `${state.oversizedPush} bytes`],
    );
  }
  return { path, status, summary: describeStatus(status, state), rows };
}

export interface SummaryRow {
  path: string;
  status: FileSyncStatus;
}

/** Every document the engine holds, least settled first. */
export function inspectAll(deps: Pick<InspectorDeps, 'trackedDocs' | 'docSyncState'>): SummaryRow[] {
  const order: Record<FileSyncStatus, number> = { error: 0, untracked: 1, offline: 2, sending: 3, confirmed: 4 };
  return deps
    .trackedDocs()
    .map((d) => ({ path: d.localPath, status: fileSyncStatus(d.placed ? deps.docSyncState(d.docName) : null, d.hasSyncedOnce) }))
    .sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path));
}

/**
 * The inspector pane. Renders `inspectNote` for the note it was pointed at
 * (or the active one) and `inspectAll` beneath it, and redraws when told to.
 *
 * Declared inside a function rather than at module level: extending `ItemView`
 * evaluates it on import, and main.ts is imported by suites whose Obsidian
 * mock has no views in it. Built on first use, it costs those suites nothing.
 */
export function createInspectorView(leaf: WorkspaceLeaf, deps: InspectorDeps, activePath: () => string | null): ItemView & SyncInspector {
  return new (inspectorClass())(leaf, deps, activePath);
}

/** What main.ts needs from the pane. */
export interface SyncInspector {
  getViewType(): string;
  show(path: string | null): void;
  refresh(): void;
}

/** Whether a leaf's view is the inspector, without naming a class that may not exist yet. */
export function isInspector(view: unknown): view is SyncInspector {
  return typeof view === 'object' && view !== null
    && (view as { getViewType?: () => string }).getViewType?.() === INSPECTOR_VIEW;
}

let built: ReturnType<typeof defineInspector> | null = null;
function inspectorClass(): ReturnType<typeof defineInspector> {
  built ??= defineInspector();
  return built;
}

function defineInspector() {
  return class SyncInspectorView extends ItemView implements SyncInspector {
    private path: string | null = null;
    private drawing: Promise<void> = Promise.resolve();

    constructor(leaf: WorkspaceLeaf, private deps: InspectorDeps, private activePath: () => string | null) {
      super(leaf);
    }

    getViewType(): string { return INSPECTOR_VIEW; }
    getDisplayText(): string { return 'Nectenda sync state'; }
    getIcon(): string { return 'activity'; }

    async onOpen(): Promise<void> { this.refresh(); }

    show(path: string | null): void {
      this.path = path;
      this.refresh();
    }

    /** Serialised, so two quick redraws cannot interleave their DOM writes. */
    refresh(): void {
      this.drawing = this.drawing.then(() => this.draw()).catch(() => undefined);
    }

    private async draw(): Promise<void> {
      const path = this.path ?? this.activePath();
      const report = path ? await inspectNote(this.deps, path) : null;
      const all = inspectAll(this.deps);

      const root = this.contentEl;
      root.empty();
      root.addClass('nectenda-inspector');
      const bar = root.createDiv({ cls: 'nectenda-inspector-bar' });
      bar.createEl('button', { text: 'Re-check' }).addEventListener('click', () => this.refresh());

      root.createEl('h4', { text: path ?? 'No note selected' });
      if (report) {
        root.createEl('p', { text: report.summary, cls: 'nectenda-inspector-summary' });
        const table = root.createEl('table', { cls: 'nectenda-inspector-table' });
        for (const [k, v] of report.rows) {
          const tr = table.createEl('tr');
          tr.createEl('th', { text: k });
          tr.createEl('td', { text: v });
        }
      }

      root.createEl('h4', { text: `All tracked notes (${all.length})` });
      const list = root.createEl('table', { cls: 'nectenda-inspector-table' });
      for (const row of all) {
        const tr = list.createEl('tr');
        tr.createEl('td', { text: row.path });
        tr.createEl('td', { text: row.status });
      }
    }
  };
}
