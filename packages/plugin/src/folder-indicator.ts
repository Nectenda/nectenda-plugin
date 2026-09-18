import type NectendaPlugin from './main';
import type { FolderMapping } from './editor-bridge';

/**
 * Adds visual indicators to the file explorer for shared folders.
 * Uses a MutationObserver to detect when the file explorer re-renders
 * and applies CSS classes to shared folder elements.
 */
export class FolderIndicator {
  private plugin: NectendaPlugin;
  private observer: MutationObserver | null = null;

  constructor(plugin: NectendaPlugin) {
    this.plugin = plugin;
  }

  start(): void {
    // Apply immediately
    this.applyIndicators();

    // Watch for file explorer changes (folders opening/closing, re-renders)
    this.observer = new MutationObserver(() => {
      this.applyIndicators();
    });

    const fileExplorer = document.querySelector('.nav-files-container');
    if (fileExplorer) {
      this.observer.observe(fileExplorer, { childList: true, subtree: true });
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.removeIndicators();
  }

  refresh(): void {
    this.applyIndicators();
  }

  private applyIndicators(): void {
    const mappings: FolderMapping[] = this.plugin.settings.folderMappings || [];
    if (mappings.length === 0) return;

    const sharedPaths = new Set(mappings.map((m) => m.localPath));

    // Find all folder elements in the file explorer
    const folderEls = Array.from(document.querySelectorAll('.nav-folder'));
    for (const el of folderEls) {
      const titleEl = el.querySelector('.nav-folder-title');
      if (!titleEl) continue;

      const path = titleEl.getAttribute('data-path');
      if (!path) continue;

      if (sharedPaths.has(path)) {
        el.classList.add('nectenda-shared');
        // Storage full is not a connection problem, and must not look like one.
        // A blocked attachment upload with an "offline" badge sends people to
        // check their network, which wastes their time and hides the actual
        // cause — the folder is still syncing text perfectly well.
        el.classList.toggle('nectenda-storage-full', this.plugin.isStorageFull());
      } else {
        el.classList.remove('nectenda-shared');
        el.classList.remove('nectenda-storage-full');
      }
    }
  }

  private removeIndicators(): void {
    const els = Array.from(document.querySelectorAll('.nectenda-shared'));
    for (const el of els) {
      el.classList.remove('nectenda-shared');
    }
  }
}
