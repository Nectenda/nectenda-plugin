import { Compartment, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { log } from './logger';

/**
 * The slot a note's collaborative binding is installed into, one editor at a
 * time (SAFE-D5).
 *
 * This replaced one `Extension[]` registered for every editor and refilled on
 * each bind. Obsidian applies a registered extension to every markdown editor,
 * so that array put the `yCollab` of whichever note bound last into *every*
 * pane, and any transaction in any pane went to that note's `Y.Text`. Two ways
 * reached it: a background pane reloading after a remote edit, and a key typed
 * into a pane in the moment before `active-leaf-change` fires. Either wrote one
 * note's text into another note's document, and published it to every vault.
 *
 * A `Compartment` is registered once instead, empty, and reconfigured on the
 * one `EditorView` a bind is for. Its content is per editor state, so every
 * other pane holds nothing rather than somebody else's binding.
 *
 * Obsidian's `workspace.updateOptions()` reconfigures the registered
 * extensions; CodeMirror keeps a compartment's current content across that, so
 * a bound view stays bound. `@codemirror/state` is external to the bundle, so
 * this `Compartment` is Obsidian's own class.
 *
 * What CodeMirror does *not* keep is the content of a state that is replaced
 * outright (`EditorView.setState`), since a compartment's content belongs to
 * the state. Should Obsidian ever do that to the bound view, the binding would
 * be gone while the plugin believed the note bound, and ContentSync would stop
 * syncing it from either side. A view plugin outside the compartment is
 * rebuilt with every new state; it notices and reports through `onLost`.
 */
export class EditorWiring {
  private readonly compartment = new Compartment();
  private bound: { view: EditorView; exts: Extension } | null = null;
  /** Register once, with `registerEditorExtension`. Empty until `bind`. */
  readonly extension: Extension = [
    this.compartment.of([]),
    ViewPlugin.define((view) => {
      this.verify(view);
      return {};
    }),
  ];
  /**
   * Called, after the current update, when the bound view has lost its
   * binding without an unbind. The caller must treat the note as unbound.
   */
  onLost: (() => void) | null = null;

  /**
   * Install `exts` in `view`, and only there. Returns whether the view now
   * carries them.
   *
   * Checked by reading the view's state back rather than trusting the
   * dispatch, because the caller stops reconciling the document from disk on
   * `true`. A view built without the registered extension, or a dispatch
   * refused mid-update, would otherwise be an editor nobody syncs while the
   * plugin believes it is bound — edits in it lost on the next reconnect.
   */
  bind(view: EditorView, exts: Extension): boolean {
    this.unbind();
    // A closed pane's view still takes a state, so reading it back would say
    // yes — for an editor nobody can type into or see.
    if ((view as unknown as { destroyed?: boolean }).destroyed) return false;
    try {
      view.dispatch({ effects: this.compartment.reconfigure(exts) });
    } catch (err) {
      log.warn('Could not install collaborative editing in this editor', { error: String(err) });
      return false;
    }
    if (this.compartment.get(view.state) !== exts) return false;
    this.bound = { view, exts };
    return true;
  }

  /**
   * Check `view` still carries the binding it was given, if it is the bound
   * one. Run by the view plugin whenever `view` gets a new state.
   */
  verify(view: EditorView): void {
    const bound = this.bound;
    if (!bound || bound.view !== view) return;
    if (this.compartment.get(view.state) === bound.exts) return;
    this.bound = null;
    // Not from inside the update that rebuilt the view's plugins: the caller
    // rebinds, and a rebind dispatches.
    queueMicrotask(() => this.onLost?.());
  }

  /** The view carrying the binding now, if any. */
  get view(): EditorView | null {
    return this.bound?.view ?? null;
  }

  /**
   * Empty the bound view's slot. Safe on a view that has been destroyed: a
   * closed pane's `EditorView` takes the state and draws nothing.
   */
  unbind(): void {
    const bound = this.bound;
    this.bound = null;
    if (!bound) return;
    if (!this.empty(bound.view, bound.exts)) {
      // Refused mid-update. Try again once that update has finished, since
      // leaving the binding in a view nobody tracks is the defect itself.
      queueMicrotask(() => {
        if (this.bound?.view === bound.view) return;
        if (!this.empty(bound.view, bound.exts)) {
          log.warn('Could not remove collaborative editing from an editor');
        }
      });
    }
  }

  /** Empty `view`'s slot if it still holds `exts`. False if the dispatch was refused. */
  private empty(view: EditorView, exts: Extension): boolean {
    if (this.compartment.get(view.state) !== exts) return true;
    try {
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return true;
    } catch {
      return false;
    }
  }
}
