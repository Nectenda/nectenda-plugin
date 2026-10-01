/**
 * The pane's dialogs.
 *
 * Every class here is self-contained: it takes what it needs through its
 * constructor and hands its answer back through a callback, touching no plugin
 * state of its own. That is why they could be lifted out of `main.ts` whole,
 * and it is worth keeping true — a modal that reaches into the plugin is a
 * modal that has to be opened to be tested.
 *
 * One flat file rather than a `modals/` directory: the tooling that assembles
 * this package for publication copies `src` without recursing, so a
 * subdirectory would be dropped silently and the published bundle would fail
 * to build.
 *
 * Two of them used to take the plugin itself. They now take three named
 * dependencies each, which is the whole of what a dialog about folder members
 * or about stored attachments turns out to need.
 */
import { App, ButtonComponent, FuzzySuggestModal, Modal, Notice, Setting, TFolder } from 'obsidian';
import { START_OVER_CONSEQUENCES, startOverReady } from './start-over';
import type { StoredMembership } from './cloud-session';
import {
  pickerCandidates,
  type FolderMember,
  type FolderRole,
  type PickerCandidate,
  type RosterUser,
} from './folder-members';
import type { PlanOffer } from './identity-client';
import type { VerifyOutcome } from './identity-session';
import { publicKeyFingerprint, type FolderInvitationInfo } from '@nectenda/shared';
import { addExistingMember, type KeyTrust } from './folder-invite';
import type { KnownKey } from './known-keys';
import type { WaitingState } from './key-grants';
import { memberRow } from './member-rows';
import { serverFetch } from './client-version.js';
import { wrapKeysFor, type FolderKeys } from './folder-crypto';
import { log } from './logger';
import { formatBytes, formatMoney, monthly, planChoice, planLabel, retryDelayMs } from './pane-summaries';
import type { TimerHandle } from './timers';

/** The shortest password this will accept anywhere it asks for one. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Shown exactly once, after registration or first key enrolment.
 *
 * There is no second chance to display this: the server holds only the master
 * key wrapped under it and cannot reproduce it. Without it, a forgotten
 * password means unrecoverable data loss.
 */
/**
 * What crash reporting sends, shown once before anything is sent.
 *
 * The setting defaults to on, and `ErrorReports.capture` still refuses until
 * this has been acknowledged. That combination is the whole point: the default
 * is the answer most people want, and nobody discovers after the fact that
 * their editor has been talking to us. Escape and a click outside are allowed
 * here — unlike the recovery key, nothing is lost by closing it, and the
 * acknowledgement is recorded either way, because being shown the notice is
 * the thing that matters.
 *
 * Both buttons are the same size on purpose. A dialogue whose "no" is a
 * greyed-out link is not a choice, and this product's whole claim is that we
 * do not need to be trusted.
 */
export class ErrorReportConsentModal extends Modal {
  constructor(
    app: App,
    private readonly onDecided: (send: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Crash reports' });
    contentEl.createEl('p', {
      text:
        'When Nectenda hits a bug, it can send us a crash report so we can fix it. ' +
        'This is on unless you turn it off, and nothing has been sent yet.',
    });

    contentEl.createEl('p', { text: 'A report contains:' });
    const sends = contentEl.createEl('ul');
    for (const line of [
      'The error and its message, with note names, file paths and anything that looks like a key or a token removed.',
      'Where in our own code it happened — line numbers in the published plugin file, which is not minified, so no separate debug file is ever uploaded.',
      'Your plugin and Obsidian versions, and whether you are on desktop or mobile.',
      'The identifier this vault already sends with every request.',
    ]) sends.createEl('li', { text: line });

    contentEl.createEl('p', { text: 'A report never contains:' });
    const never = contentEl.createEl('ul');
    for (const line of [
      'Anything you have written, or the name of any note, folder or attachment.',
      "Your vault's name.",
      'Your passphrase, your keys, or any token.',
    ]) never.createEl('li', { text: line });

    contentEl.createEl('p', {
      text:
        'Reports go to an error tracker we run ourselves, not a third party, and are deleted after 90 days. ' +
        'This only applies when you are signed in to Nectenda Cloud: against your own server there is nowhere to send them, and none are.',
    });
    const more = contentEl.createEl('p', { text: 'Full detail: ' });
    more.createEl('a', { text: 'nectenda.com/privacy', href: 'https://nectenda.com/privacy' });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Send crash reports', cls: 'mod-cta' }).onclick = () => {
      this.onDecided(true);
      super.close();
    };
    buttons.createEl('button', { text: "Don't send" }).onclick = () => {
      this.onDecided(false);
      super.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class RecoveryKeyModal extends Modal {
  private recoveryKey: string;
  private acknowledged = false;
  private onAcknowledged: (() => void) | undefined;

  constructor(app: App, recoveryKey: string, onAcknowledged?: () => void) {
    super(app);
    this.recoveryKey = recoveryKey;
    this.onAcknowledged = onAcknowledged;
  }

  /**
   * Escape, a click outside, and the close button all land here. None of them
   * closes this modal: there is no second showing of the key, so the only way
   * out is to say it has been saved.
   */
  close(): void {
    if (!this.acknowledged) {
      new Notice('Save the recovery key first, then confirm below.');
      return;
    }
    super.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Save your recovery key' });
    contentEl.createEl('p', {
      text:
        'This is the only way back into your notes if you forget your passphrase. ' +
        'It is shown once and cannot be retrieved later — not even by a server admin. ' +
        'Store it in a password manager now.',
    });

    const code = contentEl.createEl('pre', { cls: 'nectenda-recovery-key' });
    code.setText(this.recoveryKey);

    const buttons = contentEl.createDiv('modal-button-container');
    const copy = buttons.createEl('button', { text: 'Copy to clipboard' });
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.recoveryKey);
      new Notice('Recovery key copied');
    });
    const done = buttons.createEl('button', { text: "I've saved it", cls: 'mod-cta' });
    done.addEventListener('click', () => {
      this.acknowledged = true;
      this.onAcknowledged?.();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Someone from the organisation's roster to add to a folder. */
export class FolderMemberPickerModal extends FuzzySuggestModal<PickerCandidate> {
  constructor(app: App, private readonly candidates: PickerCandidate[], private readonly onChoose: (c: PickerCandidate) => void) {
    super(app);
    this.setPlaceholder(candidates.length ? 'Choose someone in this organisation…' : 'Everyone in this organisation is already a member');
  }
  getItems(): PickerCandidate[] { return this.candidates; }
  getItemText(item: PickerCandidate): string { return item.label; }
  onChooseItem(item: PickerCandidate): void {
    if (!item.addable) {
      new Notice('They have not enrolled encryption keys yet, so no folder key can be wrapped for them. Ask them to set a passphrase first.');
      return;
    }
    this.onChoose(item);
  }
}

/**
 * Recover a forgotten password with the recovery key.
 *
 * Collects everything in one modal because the flow is atomic from the user's
 * point of view: recovering the master key without setting a new password
 * leaves them able to read nothing and log in nowhere, since `authHash` is
 * salted with the password itself and the old one is gone with it.
 */
export class RecoveryModal extends Modal {
  private onSubmit: (result: { recoveryKey: string; password: string } | null) => void;
  private settled = false;

  constructor(
    app: App,
    onSubmit: (result: { recoveryKey: string; password: string } | null) => void,
  ) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText('Recover with your recovery key');
    this.contentEl.createEl('p', {
      text:
        'Enter the recovery key you saved when you registered, and choose a new ' +
        'passphrase. Your notes and every folder shared with you are unaffected.',
    });
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Without the recovery key there is nothing to do here — the server cannot ' +
        'reset a passphrase it has never seen. Case and dashes do not matter.',
    });

    let recoveryKey = '';
    let password = '';
    let confirm = '';

    const submit = (): void => {
      if (!recoveryKey.trim()) {
        new Notice('Enter your recovery key');
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        new Notice(`The passphrase must be at least ${MIN_PASSWORD_LENGTH} characters`);
        return;
      }
      if (password !== confirm) {
        new Notice('The two passphrases do not match');
        return;
      }
      this.settle({ recoveryKey: recoveryKey.trim(), password });
      this.close();
    };

    new Setting(this.contentEl).setName('Recovery key').addText((text) => {
      text.setPlaceholder('XXXX-XXXX-XXXX-XXXX-XXXX').onChange((v) => (recoveryKey = v));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    new Setting(this.contentEl).setName('New passphrase').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (password = v));
    });

    new Setting(this.contentEl).setName('Confirm new passphrase').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (confirm = v));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
    });

    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText('Recover').setCta().onClick(submit),
    );
  }

  private settle(value: { recoveryKey: string; password: string } | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onSubmit(value);
  }

  onClose(): void {
    this.settle(null);
    this.contentEl.empty();
  }
}

/**
 * Start over, for someone who has lost both the passphrase and the recovery
 * key. The words are in start-over.ts, where they are tested; this only lays
 * them out and holds the button until the address is typed.
 */
export class StartOverModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly email: string,
    private readonly onSubmit: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Start over with a new account');
    this.contentEl.createEl('p', {
      text: 'Only for when the passphrase and the recovery key are both gone for good. If you still have the recovery key, use "Forgot passphrase?" instead: it keeps everything.',
    });
    const list = this.contentEl.createEl('ul');
    for (const line of START_OVER_CONSEQUENCES) list.createEl('li', { text: line });

    let typed = '';
    let button: ButtonComponent | null = null;
    new Setting(this.contentEl)
      .setName('Type your email address to confirm')
      .setDesc(this.email)
      .addText((text) => {
        text.setPlaceholder(this.email).onChange((v) => {
          typed = v;
          button?.setDisabled(!startOverReady(typed, this.email));
        });
        window.setTimeout(() => text.inputEl.focus(), 0);
      });
    new Setting(this.contentEl).addButton((btn) => {
      button = btn;
      btn.setButtonText('Start over in 7 days').setDestructive().setDisabled(true).onClick(() => {
        if (!startOverReady(typed, this.email)) return;
        this.settle(true);
        this.close();
      });
    });
  }

  private settle(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.onSubmit(value);
  }

  onClose(): void {
    this.settle(false);
    this.contentEl.empty();
  }
}

/**
 *Asks for the passphrase so the identity key can be unwrapped, and keeps
 * asking until it opens.
 *
 * The check happens *here*, through `verify`, rather than after the dialog has
 * closed. It used to run in the caller, so a wrong passphrase could only
 * produce a toast against a dialog that was already gone, and the caller's only
 * recourse at sign-in was to treat one typo as a failed sign-in and tear the
 * session down. A wrong attempt is now answered in place.
 *
 * The master key is not stored, so nothing on disk can open a folder-key
 * envelope this device has not already cached. Folders already mapped never
 * reach this — they sync from their cached folder keys.
 *
 * Three callers, and the last two are easy to miss: confirming the passphrase
 * at sign-in, joining a folder (`loadFolderKeys`), and **Show names**, which
 * needs the identity key to read the sealed names of folders shared since the
 * last unlock. The last fires to render a list rather than to join anything.
 */
export class PasswordPromptModal extends Modal {
  private settled = false;
  private failures = 0;
  private busy = false;
  private password = '';
  private error: HTMLElement | null = null;
  private setDisabled: ((v: boolean) => void) | null = null;
  private clearInput: (() => void) | null = null;
  private countdown: TimerHandle | null = null;
  /** Wall-clock deadline for the pause. Enter bypasses a disabled button. */
  private blockedUntil = 0;

  constructor(
    app: App,
    private opts: {
      reason: string;
      verify: (password: string) => Promise<VerifyOutcome>;
      onDone: (unlocked: boolean) => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Passphrase required');
    this.contentEl.createEl('p', { text: this.opts.reason });
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Your passphrase is not stored and never leaves this device. It is needed here to ' +
        'unwrap your encryption key, and takes a moment to process.',
    });

    new Setting(this.contentEl).setName('Passphrase').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (this.password = v));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.attempt();
      });
      this.clearInput = () => {
        this.password = '';
        text.setValue('');
        text.inputEl.focus();
      };
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    // `mod-warning` is Obsidian's own, so this needs no rule in styles.css and
    // stays outside the nectenda-* contract styles-contract.test.ts enforces.
    this.error = this.contentEl.createEl('p', { cls: 'mod-warning' });
    this.error.hide();

    new Setting(this.contentEl)
      .addButton((btn) =>
        // Cancelling is a real choice and needs a button. There was none: the
        // only way out was Esc, which the caller could not tell from a wrong
        // passphrase, and which used to cost the whole session.
        btn.setButtonText('Cancel').onClick(() => this.close()),
      )
      .addButton((btn) => {
        btn.setButtonText('Unlock').setCta().onClick(() => void this.attempt());
        this.setDisabled = (v) => { btn.setDisabled(v); };
      });
  }

  private show(message: string): void {
    if (!this.error) return;
    this.error.setText(message);
    this.error.show();
  }

  private async attempt(): Promise<void> {
    // Guarded rather than trusted: Enter and the button both land here, and a
    // second press while the KDF is running would start a parallel derivation
    // against a dialog that may already have settled.
    if (this.busy || this.settled) return;
    // Checked here rather than only on the button: the field takes Enter too,
    // and disabling the button alone would let the keyboard walk past the pause.
    if (Date.now() < this.blockedUntil) return;
    if (!this.password) {
      this.show('Enter your passphrase.');
      return;
    }
    this.busy = true;
    this.setDisabled?.(true);
    this.show('Checking…');
    let outcome: VerifyOutcome;
    try {
      outcome = await this.opts.verify(this.password);
    } catch (err) {
      // verify is not meant to throw; if it does, say so rather than leaving
      // the dialog stuck on "Checking…".
      log.error('The passphrase check threw', { error: String(err) });
      outcome = { ok: false, message: 'Something went wrong checking that passphrase.' };
    }
    // The dialog may have been closed while the KDF ran. Everything below this
    // point either touches a detached element or re-settles a finished prompt.
    if (this.settled) return;
    this.busy = false;

    if (outcome.ok) {
      this.settle(true);
      this.close();
      return;
    }
    if (outcome.fatal) {
      // Not a typo — the caller has said something more specific and asked the
      // user not to try again until they know why. Offering another attempt
      // here would contradict it.
      this.settle(false);
      this.close();
      return;
    }

    this.failures += 1;
    this.clearInput?.();
    const wait = retryDelayMs(this.failures);
    this.blockedUntil = Date.now() + wait;
    if (wait === 0) {
      this.show(outcome.message);
      this.setDisabled?.(false);
      return;
    }
    let left = Math.ceil(wait / 1000);
    const tick = (): void => this.show(`${outcome.message} Try again in ${left}s.`);
    tick();
    this.countdown = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        tick();
        return;
      }
      this.stopCountdown();
      if (this.settled) return;
      this.show(outcome.message);
      this.setDisabled?.(false);
    }, 1_000);
  }

  private stopCountdown(): void {
    if (this.countdown === null) return;
    window.clearInterval(this.countdown);
    this.countdown = null;
  }

  private settle(unlocked: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.opts.onDone(unlocked);
  }

  onClose(): void {
    // Closing without unlocking has to resolve the caller, or a cancelled
    // prompt would leave whatever awaited it hanging for the session. Esc, the
    // background and Cancel all arrive here; the latch means a successful
    // unlock that closed the dialog itself is not overwritten.
    this.stopCountdown();
    this.settle(false);
    this.contentEl.empty();
  }
}

/**
 * Choosing a plan, before being sent to the payment page.
 *
 * Until this existed, *Change plan* went straight to a checkout for Personal,
 * monthly, one seat, whatever the person actually wanted. It could not offer
 * anything else because the plugin had no idea what was for sale.
 *
 * **Every figure here comes from the server**, fetched when the dialog opens.
 * The prices exist in three places already — the shard's plans table, the
 * public pricing page, and the payment provider's own products — and a fourth
 * compiled into this bundle would be the only copy that could not be corrected
 * without shipping a release. So this file contains no prices, and if the
 * server cannot be reached it says so rather than guessing.
 *
 * The seat control follows `perSeat`, which is not cosmetic. A flat plan sells
 * one subscription with its seats included; treating that as "one seat" is
 * exactly what once capped a six-seat plan at one, below the free tier.
 */
export class PlanPickerModal extends Modal {
  private plans: PlanOffer[] = [];
  private planId = '';
  private term: 'month' | 'year' = 'year';
  private seats = 1;
  private loading = true;
  private error: string | null = null;

  constructor(
    app: App,
    private readonly load: () => Promise<PlanOffer[]>,
    private readonly onChosen: (choice: { planId: string; term: 'month' | 'year'; seats: number }) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    void this.fetch();
    this.render();
  }

  private async fetch(): Promise<void> {
    try {
      this.plans = await this.load();
      // Default to whatever is cheapest per month, which is the yearly line of
      // the smallest plan — not to a hardcoded name that may not be for sale.
      const first = [...this.plans].sort((a, b) => monthly(a) - monthly(b))[0];
      if (first) {
        this.planId = first.planId;
        this.term = first.term;
        this.seats = first.perSeat ? 1 : 1;
      } else {
        this.error = 'This server is not selling any plans at the moment.';
      }
    } catch (err) {
      // Named, not smoothed over. Somebody is about to be asked for money and
      // a dialog that shrugs is the point at which they stop trusting it.
      this.error = err instanceof Error ? err.message : 'The plans could not be loaded.';
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private offer(): PlanOffer | undefined {
    return this.plans.find((p) => p.planId === this.planId && p.term === this.term);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Choose a plan' });

    if (this.loading) {
      contentEl.createEl('p', { text: 'Loading what is available…' });
      return;
    }
    if (this.error) {
      contentEl.createEl('p', { text: this.error });
      contentEl.createEl('p', {
        cls: 'mod-warning',
        text: 'Nothing has been charged. Try again in a moment, or write to support@nectenda.com.',
      });
      return;
    }

    // One row per plan, not per plan-and-term: the term is its own control, so
    // six products read as three choices and a billing toggle.
    const names = [...new Set(this.plans.map((p) => p.planId))];
    new Setting(contentEl)
      .setName('Plan')
      .addDropdown((d) => {
        for (const id of names) d.addOption(id, planLabel(id));
        d.setValue(this.planId).onChange((v) => {
          this.planId = v;
          // A flat plan has no seats to choose, so any count carried over from
          // a per-seat plan is dropped rather than quietly sent.
          if (!this.offer()?.perSeat) this.seats = 1;
          this.render();
        });
      });

    new Setting(contentEl)
      .setName('Billing')
      .setDesc(this.savingLine())
      .addDropdown((d) => {
        for (const t of ['month', 'year'] as const) {
          if (this.plans.some((p) => p.planId === this.planId && p.term === t)) {
            d.addOption(t, t === 'month' ? 'Monthly' : 'Yearly');
          }
        }
        d.setValue(this.term).onChange((v) => { this.term = v as 'month' | 'year'; this.render(); });
      });

    const chosen = this.offer();
    if (chosen?.perSeat) {
      new Setting(contentEl)
        .setName('Seats')
        .setDesc(`Up to ${chosen.maxSeats}. You can change this later.`)
        .addText((t) => {
          t.inputEl.type = 'number';
          t.inputEl.min = '1';
          t.inputEl.max = String(chosen.maxSeats);
          t.setValue(String(this.seats)).onChange((v) => {
            const n = Number(v);
            // Clamped rather than refused: the server enforces the same ceiling
            // and would reject it, but being told at checkout is too late to be
            // useful.
            this.seats = Number.isInteger(n) && n >= 1 ? Math.min(n, chosen.maxSeats) : 1;
            this.renderTotal();
          });
        });
    } else if (chosen) {
      new Setting(contentEl)
        .setName('Seats')
        .setDesc(`${chosen.maxSeats} included. This plan is one subscription rather than a price per seat.`);
    }

    const total = contentEl.createDiv({ cls: 'setting-item' });
    total.createDiv({ cls: 'setting-item-info' }).createDiv({ cls: 'setting-item-name', text: 'Total' });
    this.totalEl = total.createDiv({ cls: 'setting-item-control' });
    this.renderTotal();

    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Payment is taken by Creem, our payment provider, on their page in your browser. ' +
        'Tax is included in the price shown.',
    });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Continue to payment', cls: 'mod-cta' }).onclick = () => {
      const offer = this.offer();
      if (!offer) return;
      this.onChosen(planChoice(offer, this.seats));
      super.close();
    };
    buttons.createEl('button', { text: 'Cancel' }).onclick = () => super.close();
  }

  private totalEl: HTMLElement | null = null;

  private renderTotal(): void {
    const offer = this.offer();
    if (!this.totalEl || !offer) return;
    const seats = offer.perSeat ? this.seats : 1;
    this.totalEl.setText(
      `${formatMoney(offer.amount * seats, offer.currency)} ${offer.term === 'year' ? 'a year' : 'a month'}`,
    );
  }

  /** Only shown when both terms exist and the yearly one is actually cheaper. */
  private savingLine(): string {
    const m = this.plans.find((p) => p.planId === this.planId && p.term === 'month');
    const y = this.plans.find((p) => p.planId === this.planId && p.term === 'year');
    if (!m || !y || y.amount >= m.amount * 12) return 'Billed by the month or by the year.';
    const saved = m.amount * 12 - y.amount;
    return `Yearly saves ${formatMoney(saved, y.currency)} a year.`;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Choose the encryption passphrase on the first device.
 *
 * Said plainly before it is chosen, not after: this passphrase cannot be reset
 * by anyone, and the recovery key that follows is the only way back.
 */
export class SetPassphraseModal extends Modal {
  private onSubmit: (password: string | null) => void;
  private settled = false;

  constructor(app: App, onSubmit: (password: string | null) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText('Choose an encryption passphrase');
    this.contentEl.createEl('p', {
      text:
        'This passphrase protects every note you sync. It never leaves this device and nobody at ' +
        'Nectenda can reset it. You will be given a recovery key next — keep it somewhere safe.',
    });
    let first = '';
    let second = '';
    const submit = (): void => {
      if (first.length < MIN_PASSWORD_LENGTH) {
        new Notice(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
        return;
      }
      if (first !== second) {
        new Notice('The two entries do not match');
        return;
      }
      this.settle(first);
      this.close();
    };
    new Setting(this.contentEl).setName('Passphrase').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (first = v));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).setName('Again').addText((text) => {
      text.inputEl.type = 'password';
      text.onChange((v) => (second = v));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
    });
    new Setting(this.contentEl).addButton((btn) => btn.setButtonText('Set passphrase').setCta().onClick(submit));
  }

  private settle(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onSubmit(value);
  }

  onClose(): void {
    this.settle(null);
    this.contentEl.empty();
  }
}

/** Invite someone to an organisation by email. The email is a notification; the invitation also shows in their settings. */
export class InviteByEmailModal extends Modal {
  constructor(
    app: App,
    private readonly membership: StoredMembership,
    private readonly onSubmit: (email: string, role: 'member' | 'admin') => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Invite to ${this.membership.accountName}`);
    let email = '';
    let role: 'member' | 'admin' = 'member';
    new Setting(this.contentEl).setName('Email address').addText((text) => {
      text.setPlaceholder('name@example.com').onChange((v) => (email = v.trim()));
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    const roles = new Setting(this.contentEl).setName('Role');
    roles.addDropdown((drop) => {
      drop.addOption('member', 'Member');
      // Only an owner may make an admin; the service refuses otherwise.
      if (this.membership.role === 'owner') drop.addOption('admin', 'Admin');
      drop.setValue('member').onChange((v) => (role = v as 'member' | 'admin'));
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText('Send invitation').setCta().onClick(async () => {
        if (!email.includes('@')) {
          new Notice('Enter an email address');
          return;
        }
        await this.onSubmit(email, role);
        this.close();
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Naming an organisation you are about to create. */
export class NameOrganisationModal extends Modal {
  constructor(
    app: App,
    private readonly suggestion: string,
    private readonly onSubmit: (name: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Create an organisation');
    let name = this.suggestion;
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'An organisation holds shared folders and the people you share them with. '
        + 'It starts on the free plan: three people, text sync, no attachments.',
    });
    new Setting(this.contentEl).setName('Name').addText((text) => {
      text.setValue(this.suggestion).onChange((v) => (name = v.trim()));
      window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 0);
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText('Create').setCta().onClick(async () => {
        if (!name) {
          new Notice('Give the organisation a name');
          return;
        }
        this.close();
        await this.onSubmit(name);
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  private folders: TFolder[];
  private onChoose: (folder: TFolder) => void;

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.folders = this.getAllFolders();
    this.onChoose = onChoose;
    this.setPlaceholder('Pick a folder...');
  }

  private getAllFolders(): TFolder[] {
    const folders: TFolder[] = [];
    const root = this.app.vault.getRoot();
    const walk = (folder: TFolder) => {
      // Skip hidden folders
      if (folder.path.startsWith('.')) return;
      if (folder.path) folders.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(root);
    return folders.sort((a, b) => a.path.localeCompare(b.path));
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(item: TFolder): string {
    return item.path;
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item);
  }
}

/**
 * Pick one of a short list — an organisation, a shared folder — for a command
 * that needs to know which. One class for both: they differ only in what the
 * rows say.
 */
export class ChoicePickerModal<T> extends FuzzySuggestModal<T> {
  private items: T[];
  private text: (item: T) => string;
  private onChoose: (item: T) => void;

  constructor(app: App, items: T[], text: (item: T) => string, placeholder: string, onChoose: (item: T) => void) {
    super(app);
    this.items = items;
    this.text = text;
    this.onChoose = onChoose;
    this.setPlaceholder(placeholder);
  }

  getItems(): T[] {
    return this.items;
  }

  getItemText(item: T): string {
    return this.text(item);
  }

  onChooseItem(item: T): void {
    this.onChoose(item);
  }
}

/**
 * Asked before opening an attachment larger than this device has handled.
 *
 * The wording matters more than the buttons. A user who is told "this might not
 * work" and then watches the app vanish has been dealt with honestly; one who is
 * told nothing concludes the app is broken. And the cost of saying no is stated,
 * because "skip" sounds permanent and is not.
 */
/**
 * "This cannot be undone" is the whole of it, so the modal says what goes and
 * what stays before it says it.
 */
/**
 * A yes-or-no question with the consequence spelled out. Dismissing it is a
 * no, like the unshare dialog: closing a window is not consent.
 */
export class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly text: { title: string; body: string; confirm: string; cancel: string },
    private readonly decide: (proceed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.text.title);
    this.contentEl.createEl('p', { text: this.text.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.text.cancel).onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText(this.text.confirm).setDestructive().onClick(() => this.answer(true)));
  }

  private answer(proceed: boolean): void {
    this.answered = true;
    this.decide(proceed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.decide(false);
  }
}

export class UnshareFolderModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly folderName: string, private readonly others: number | null, private readonly decide: (proceed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `Unshare "${this.folderName}"?` });
    contentEl.createEl('p', {
      text: 'This removes the folder from the server: its copy of every note, the edit history, and every attachment — for everyone.',
    });
    if (this.others !== null && this.others > 0) {
      contentEl.createEl('p', {
        text: `${this.others} other ${this.others === 1 ? 'person' : 'people'} will stop receiving changes.`,
      });
    }
    contentEl.createEl('p', {
      text: 'Nothing on disk changes. The notes in this vault stay where they are, and everyone keeps theirs as ordinary files. '
        + 'This cannot be undone: sharing the folder again makes a new one, with a new history.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Keep sharing').onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText('Unshare').setDestructive().onClick(() => this.answer(true)));
  }

  private answer(proceed: boolean): void {
    this.answered = true;
    this.decide(proceed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissing is not consent to something that cannot be undone.
    if (!this.answered) this.decide(false);
  }
}

/**
 * Removing the device you are sitting at, confirmed.
 *
 * `window.confirm` did this until 18 September 2026. Obsidian's review flags it,
 * and it deserved flagging for a reason beyond the rule: a browser dialog blocks
 * the renderer, looks nothing like the app around it, and cannot be answered by
 * a test. This shape can — see `confirmRemoveDevice`, and `unshare-folder.test.ts`
 * for the same seam being used to answer without driving a modal.
 */
export class RemoveDeviceModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly organisation: string, private readonly decide: (proceed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Remove this device?' });
    contentEl.createEl('p', {
      text: `This is the device you are using. It stops syncing ${this.organisation} until it is added again.`,
    });
    contentEl.createEl('p', {
      text: 'Nothing on disk changes. Every note in this vault stays exactly where it is — they simply stop receiving changes from other people, and yours stop reaching them.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Keep it').onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText('Remove').setDestructive().onClick(() => this.answer(true)));
  }

  private answer(proceed: boolean): void {
    this.answered = true;
    this.decide(proceed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissing is not consent, the same rule UnshareFolderModal keeps.
    if (!this.answered) this.decide(false);
  }
}

export class LargeAttachmentModal extends Modal {
  private relativePath: string;
  private bytes: number;
  private decide: (proceed: boolean) => void;
  private answered = false;

  constructor(app: App, relativePath: string, bytes: number, decide: (proceed: boolean) => void) {
    super(app);
    this.relativePath = relativePath;
    this.bytes = bytes;
    this.decide = decide;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Large attachment' });
    contentEl.createEl('p', {
      text: `"${this.relativePath}" is ${formatBytes(this.bytes)}, which is larger than this `
        + 'device has opened before.',
    });
    contentEl.createEl('p', {
      text: 'Opening it may make Obsidian close and reopen on this device. If that happens, '
        + 'nothing is lost — the file stays on the server and this device will skip it next '
        + 'time, with a button to try again.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Skip on this device').onClick(() => this.answer(false)))
      .addButton((b) => b.setButtonText('Download anyway').setCta().onClick(() => this.answer(true)));
  }

  private answer(proceed: boolean): void {
    this.answered = true;
    this.decide(proceed);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    // Dismissing without choosing is not consent to attempt something that
    // might kill the app.
    if (!this.answered) this.decide(false);
  }
}

/**
 * Offered when a folder is shared while Obsidian is set to drop attachments
 * somewhere that will not sync.
 *
 * Phrased as what will happen rather than what is misconfigured. The setting is
 * Obsidian's default and perfectly reasonable until the moment a folder is
 * shared, so there is nothing for the user to feel they got wrong.
 */
export class AttachmentLocationModal extends Modal {
  private accept: () => void;

  constructor(app: App, accept: () => void) {
    super(app);
    this.accept = accept;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Where should attachments be saved?' });
    contentEl.createEl('p', {
      text: 'Obsidian currently saves files you drop into a note to the vault root, which '
        + 'is not inside a shared folder. Attachments added to shared notes would not be '
        + 'uploaded, and everyone else would see a broken link.',
    });
    contentEl.createEl('p', {
      text: 'Saving them next to the note keeps them inside the shared folder, so they sync '
        + 'with it. This changes an Obsidian setting and affects every vault folder, not '
        + 'only shared ones.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Leave it as it is').onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText('Save beside the note').setCta().onClick(() => {
          this.accept();
          this.close();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Who can reach a shared folder, and what they may do.
 *
 * Membership is editing rights: every member may read and write. Owners can
 * additionally change who else is a member.
 *
 * There is deliberately no read-only role. Obsidian gives a plugin no way to
 * veto a file operation, so while the editor can be locked and the server can
 * refuse writes, nothing prevents a read-only member deleting or creating files
 * from the file explorer — and a role that implies a guarantee it cannot keep
 * is worse than no role at all.
 *
 * Adding someone here grants them access on the server. Under end-to-end
 * encryption that is only half of it — they also need the folder key wrapped
 * for them, which the server cannot do because it does not have it; this
 * modal wraps it (`grantKey`) the moment the server says who they are. A
 * member added before that step existed sees the folder but cannot read it.
 */
export interface FolderMembersDeps {
  /** Where this folder's members live, and the credential for asking. */
  server(): { base: string; token: string };
  /**
   * This account's own identity public key, or null when none is enrolled.
   * Only used to print a fingerprint, so "not enrolled" simply omits the note.
   */
  ownPublicKey(): string | null;
  /**
   * The folder's keys, for wrapping to somebody newly added — or null, when
   * this device does not hold them. That is reported rather than hidden: the
   * member is added and simply cannot read anything yet.
   */
  folderKeys(): FolderKeys | null;
  /** Whether a collaborator's key may be used; refuses one that changed. */
  trust: KeyTrust;
  /** What this vault remembers of someone's key, for the "compared" line. */
  known(email: string): KnownKey | undefined;
  /** The person compared this fingerprint with its owner out of band. */
  markCompared(email: string, fingerprint: string): Promise<void>;
  /** Why a member is still without a key, as the last automatic pass saw it. */
  waiting(userId: string): WaitingState | undefined;
  /** Open the invite dialog for this folder. */
  invite(): void;
  /**
   * This vault owns the folder, and so may change who is in it. Everyone else
   * sees the same people and fingerprints, and may mark one compared.
   */
  canManage: boolean;
}

export class FolderMembersModal extends Modal {
  private deps: FolderMembersDeps;
  private folderId: string;
  private folderName: string;

  constructor(app: App, deps: FolderMembersDeps, folderId: string, folderName: string) {
    super(app);
    this.deps = deps;
    this.folderId = folderId;
    this.folderName = folderName;
  }

  onOpen(): void {
    this.titleEl.setText(`People in ${this.folderName}`);
    void this.render();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.deps.server().token}`,
      'Content-Type': 'application/json',
    };
  }

  private shareDeps(): Parameters<typeof addExistingMember>[0] {
    return {
      server: this.deps.server(),
      folderId: this.folderId,
      keys: this.deps.folderKeys(),
      trust: this.deps.trust,
      fetch: serverFetch,
      wrap: wrapKeysFor,
    };
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    const { base } = this.deps.server();
    let members: FolderMember[] = [];
    try {
      const res = await serverFetch(`${base}/folders/${this.folderId}/members`, { headers: this.headers() });
      if (!res.ok) {
        contentEl.createEl('p', { text: 'Could not load the people in this folder.' });
        return;
      }
      ({ members } = (await res.json()) as { members: FolderMember[] });
    } catch {
      contentEl.createEl('p', { text: 'Could not reach the server.' });
      return;
    }

    const { canManage } = this.deps;
    if (canManage) {
      new Setting(contentEl)
        .setName('Invite someone')
        .setDesc('By email. Someone new gets an invitation and has the folder as soon as they join.')
        .addButton((btn) => btn.setButtonText('Invite…').setCta().onClick(() => {
          this.close();
          this.deps.invite();
        }));
    }

    new Setting(contentEl).setName('People').setHeading();
    for (const member of members) {
      // The fingerprint is the only defence against a server that substitutes
      // its own public key for a collaborator's. Without comparing these out of
      // band — in person, over a call — the guarantee holds against an operator
      // who only reads, not one who actively interferes. Remembering the key a
      // person was first shared with, and refusing a different one later, is
      // what this vault can do on its own; comparing is what rules out the start.
      const fingerprint = member.publicKey
        ? await publicKeyFingerprint(member.publicKey)
        : null;
      const self = !!member.publicKey && member.publicKey === this.deps.ownPublicKey();
      const email = member.email ?? member.username;
      const row = memberRow(member, {
        fingerprint,
        self,
        known: this.deps.known(email),
        waiting: this.deps.waiting(member.userId),
        canManage,
      });
      const who = row.name;
      const setting = new Setting(contentEl).setName(who).setDesc(row.desc);
      if (row.warning) setting.descEl.addClass('mod-warning');

      if (row.compare && fingerprint) {
        setting.addButton((btn) =>
          btn
            .setButtonText('Mark as compared')
            .setTooltip(`Only after checking ${fingerprint} with ${who} outside Nectenda`)
            .onClick(async () => {
              await this.deps.markCompared(email, fingerprint);
              await this.render();
            }),
        );
      }

      if (row.role) setting.addDropdown((drop) => {
        drop
          .addOption('owner', 'Owner')
          .addOption('editor', 'Editor')
          .setValue(member.role)
          .onChange(async (role) => {
            const outcome = await addExistingMember(this.shareDeps(), { userId: member.userId, who, role: role as FolderRole });
            new Notice(outcome.ok ? `${who} is now ${role}` : outcome.message, outcome.ok ? 4000 : 10000);
            await this.render();
          });
      });

      if (row.remove) setting.addButton((btn) =>
        btn
          .setButtonText('Remove')
          .setDestructive()
          .onClick(async () => {
            const res = await serverFetch(`${base}/folders/${this.folderId}/members/${member.userId}`, {
              method: 'DELETE',
              headers: this.headers(),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              new Notice(body.error ?? 'Could not remove that member');
              return;
            }
            new Notice(`Removed ${who}`);
            await this.render();
          }),
      );
    }

    // The server lists invitations to owners only, and an editor could not
    // revoke one anyway.
    if (canManage) await this.renderInvitations(contentEl);

    const mine = this.deps.ownPublicKey();
    if (mine) {
      const note = contentEl.createEl('p', { cls: 'setting-item-description' });
      note.setText(
        `Your key: ${await publicKeyFingerprint(mine)} — compare these with collaborators ` +
          'through some channel other than this server. A server that swapped a key for its ' +
          'own could read everything, and the fingerprint is what would give it away.',
      );
    }

    if (!canManage) {
      contentEl.createEl('p', { cls: 'setting-item-description', text: 'Only the folder\'s owners can invite or remove people.' });
      return;
    }

    let role: FolderRole = 'editor';
    // Picked from the organisation's roster, not typed: the person must
    // already hold a seat here — folders never cross organisations — and an
    // address typed by hand had to match exactly or the add failed.
    new Setting(contentEl)
      .setName('Add someone from the organisation')
      .setDesc('Someone who already belongs to this organisation.')
      .addDropdown((drop) =>
        drop
          .addOption('editor', 'Editor')
          .addOption('owner', 'Owner')
          .setValue('editor')
          .onChange((v) => (role = v as FolderRole)),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Choose…')
          .onClick(async () => {
            let users: RosterUser[];
            try {
              const res = await serverFetch(`${base}/account`, { headers: this.headers() });
              if (!res.ok) throw new Error(`account: ${res.status}`);
              ({ users = [] } = (await res.json()) as { users?: RosterUser[] });
            } catch (err) {
              new Notice('Could not load the organisation\'s members.');
              log.warn('Could not list the roster for a folder picker', { error: String(err) });
              return;
            }
            // The owner is a member already, so the roster minus the members
            // leaves them out without needing to know their own id here.
            new FolderMemberPickerModal(this.app, pickerCandidates(users, members, null), (c) => {
              void (async () => {
                const who = c.label.split(' — ')[0];
                const outcome = await addExistingMember(this.shareDeps(), { userId: c.id, who, role });
                // Only claim success if the key actually reached them: a
                // cheerful "is now editor" printed after a failure buries the
                // one message that matters.
                new Notice(outcome.ok ? `${who} is now ${role}. ${outcome.message}` : outcome.message, outcome.ok ? 6000 : 10000);
                await this.render();
              })().catch((err: unknown) => {
                log.warn('Could not add the member', { error: String(err) });
              });
            }).open();
          }),
      );
  }

  /**
   * Invitations to this folder nobody has claimed yet. Shown so an owner can
   * see why somebody has not arrived — waiting, expired, or no longer valid —
   * instead of the row quietly not existing. A server from before folder
   * invitations answers 404, and the section is simply left out.
   */
  private async renderInvitations(contentEl: HTMLElement): Promise<void> {
    const { base } = this.deps.server();
    let invitations: FolderInvitationInfo[] = [];
    try {
      const res = await serverFetch(`${base}/folders/${this.folderId}/invitations`, { headers: this.headers() });
      if (!res.ok) return;
      ({ invitations } = (await res.json()) as { invitations: FolderInvitationInfo[] });
    } catch {
      return;
    }
    if (!invitations.length) return;
    new Setting(contentEl).setName('Invited').setHeading();
    for (const inv of invitations) {
      const state = inv.lapsedReason === 'inviter-not-owner'
        ? 'no longer valid: whoever sent it stopped owning this folder'
        : inv.expired
          ? 'expired — invite them again'
          : `waiting for them to join (until ${new Date(inv.expiresAt * 1000).toLocaleDateString()})`;
      const row = new Setting(contentEl).setName(inv.email).setDesc(`${inv.role} — ${state}`);
      if (inv.expired || inv.lapsedReason) row.descEl.addClass('mod-warning');
      row.addButton((btn) =>
        btn.setButtonText('Revoke').setDestructive().onClick(async () => {
          const res = await serverFetch(`${base}/folders/${this.folderId}/invitations/${inv.id}`, { method: 'DELETE', headers: this.headers() });
          if (!res.ok) new Notice('Could not revoke that invitation');
          await this.render();
        }),
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Invite someone to one shared folder, by email.
 *
 * The one place to start collaborating on a folder. What happens next depends
 * on who they are — `folder-invite.ts` decides — and the caller does it; this
 * only collects the address and the role.
 */
export class InviteToFolderModal extends Modal {
  constructor(
    app: App,
    private readonly folderName: string,
    private readonly onSubmit: (email: string, role: FolderRole) => Promise<boolean>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Invite to ${this.folderName}`);
    let email = '';
    let role: FolderRole = 'editor';
    const submit = async (): Promise<void> => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        new Notice('Enter an email address');
        return;
      }
      if (await this.onSubmit(email, role)) this.close();
    };
    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'They can edit everything in this folder. Someone new is also invited to your organisation, and takes a seat when they join.',
    });
    new Setting(this.contentEl).setName('Email address').addText((text) => {
      text.setPlaceholder('name@example.com').onChange((v) => (email = v.trim()));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void submit();
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl)
      .setName('Role')
      .setDesc('Owners can also invite and remove people.')
      .addDropdown((drop) =>
        drop.addOption('editor', 'Editor').addOption('owner', 'Owner').setValue('editor').onChange((v) => (role = v as FolderRole)),
      );
    new Setting(this.contentEl).addButton((btn) => btn.setButtonText('Send invitation').setCta().onClick(() => void submit()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * What is taking up space, and a way to remove it.
 *
 * Lists only folders this vault has mapped, and says why. The owner of a folder
 * pays for it, but the server stores ciphertext under opaque ids and cannot
 * name a single file in it — so a folder the owner has not mapped can be
 * reported as a total and nothing more. That is not a gap to apologise for; it
 * is the guarantee working, and the honest thing is to say so rather than
 * present an empty list.
 */
export interface ManageStorageDeps {
  /** The shared folders mapped into this vault. Only these can be listed. */
  mappings(): Array<{ sharedFolderId: string; localPath: string }>;
  /** What this vault holds for a folder, largest first. */
  stored(folderId: string): Array<{ relativePath: string; bytes: number }>;
  /** Remove one, to the vault trash and from the server. */
  remove(folderId: string, relativePath: string): Promise<boolean>;
}

export class ManageStorageModal extends Modal {
  private deps: ManageStorageDeps;
  private onChange: () => void;

  constructor(app: App, deps: ManageStorageDeps, onChange: () => void) {
    super(app);
    this.deps = deps;
    this.onChange = onChange;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Manage storage' });

    const mappings = this.deps.mappings();
    if (mappings.length === 0) {
      contentEl.createEl('p', { text: 'No shared folders are mapped in this vault.' });
      return;
    }

    let anything = false;
    for (const mapping of mappings) {
      const items = this.deps.stored(mapping.sharedFolderId);
      if (items.length === 0) continue;
      anything = true;

      const total = items.reduce((n, i) => n + i.bytes, 0);
      contentEl.createEl('h4', {
        text: `${mapping.localPath} — ${formatBytes(total)} in ${items.length} file(s)`,
      });

      // Largest first: the only ordering that helps somebody trying to free
      // space in as few decisions as possible.
      for (const item of items) {
        new Setting(contentEl)
          .setName(item.relativePath)
          .setDesc(formatBytes(item.bytes))
          .addButton((b) =>
            b.setButtonText('Delete').setDestructive().onClick(async () => {
              const ok = await this.deps.remove(mapping.sharedFolderId, item.relativePath);
              if (ok) {
                new Notice(
                  `Nectenda: "${item.relativePath}" moved to the vault trash and removed `
                    + 'from the server.',
                );
                this.onChange();
                this.render();
              }
            }),
          );
      }
    }

    if (!anything) {
      contentEl.createEl('p', { text: 'No attachments are stored in your mapped folders.' });
    }

    contentEl.createEl('p', {
      text: 'Only folders mapped in this vault can be listed. The server stores your '
        + 'attachments encrypted under names it cannot read, so it cannot tell you what is '
        + 'in a folder you have not mapped here — map it to manage it, or delete the whole '
        + 'folder from the folder list.',
      cls: 'setting-item-description',
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** One line of text and a button: a pasted link, most often. */
export class TextPromptModal extends Modal {
  constructor(
    app: App,
    private readonly opts: { title: string; placeholder: string; cta: string; submit: (value: string) => Promise<void> },
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    let value = '';
    const go = async (): Promise<void> => {
      if (!value.trim()) return;
      this.close();
      await this.opts.submit(value.trim());
    };
    new Setting(this.contentEl).addText((text) => {
      text.setPlaceholder(this.opts.placeholder).onChange((v) => (value = v));
      text.inputEl.addClass('nectenda-wide-input');
      text.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') void go(); });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText(this.opts.cta).setCta().onClick(() => void go()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * A shared folder's settings page, as a dialog: the same page the settings
 * pane shows, drawn by the same code, for the palette and the menus, which
 * cannot open a page of the settings pane directly.
 */
export class FolderSettingsModal extends Modal {
  constructor(app: App, private readonly name: string, private readonly draw: (el: HTMLElement) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.name);
    this.draw(this.contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

