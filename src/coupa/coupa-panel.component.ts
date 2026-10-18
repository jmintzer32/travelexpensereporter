import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { MatIconModule } from '@angular/material/icon';
import { TripReport } from '../models/trip-report.model';
import { APP_CATEGORIES, CoupaDateFormat, CoupaService } from './coupa.service';
import { CoupaEntryModeComponent } from './coupa-entry-mode.component';

// Set on <html> by the Chrome extension's content script (coupa-extension/content-app.js).
const EXTENSION_ATTR = 'data-coupa-filler-extension';

@Component({
  selector: 'app-coupa-panel',
  templateUrl: './coupa-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [FormsModule, MatIconModule, CoupaEntryModeComponent],
})
export class CoupaPanelComponent {
  private readonly coupa = inject(CoupaService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly reports = input.required<TripReport[]>();

  readonly settings = this.coupa.settings;
  readonly categories = APP_CATEGORIES;
  readonly dateFormats: CoupaDateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YY'];

  readonly lines = computed(() => this.coupa.buildLines(this.reports()));
  readonly entryModeOpen = signal(false);
  readonly showSettings = signal(false);
  readonly showBookmarkletHelp = signal(false);
  readonly notice = signal<string | null>(null);
  readonly extensionVersion = signal<string | null>(null);
  readonly bookmarkletHref = signal<SafeUrl | null>(null);
  private bookmarkletCode = '';

  constructor() {
    this.loadBookmarklet();
    // The extension's content script runs after the page loads; check again shortly.
    this.detectExtension();
    setTimeout(() => this.detectExtension(), 1500);
  }

  setDateFormat(format: CoupaDateFormat): void {
    this.coupa.updateSettings({ dateFormat: format });
  }

  setCurrency(currency: string): void {
    this.coupa.updateSettings({ currency: currency.trim().toUpperCase() });
  }

  setExpenseType(category: string, coupaType: string): void {
    this.coupa.setExpenseType(category, coupaType.trim());
  }

  resetSettings(): void {
    this.coupa.resetSettings();
  }

  async copyForBookmarklet(): Promise<void> {
    const json = JSON.stringify(this.coupa.buildPayload(this.reports()));
    try {
      await navigator.clipboard.writeText(json);
      this.flash(`Copied ${this.lines().length} lines. In Coupa, click the “Coupa Filler” bookmark and paste.`);
    } catch {
      window.prompt('Copy this, then paste it into the Coupa Filler panel:', json);
    }
  }

  async copyBookmarkletCode(): Promise<void> {
    if (!this.bookmarkletCode) return;
    try {
      await navigator.clipboard.writeText(this.bookmarkletCode);
      this.flash('Bookmarklet copied. Create a new bookmark and paste it as the URL.');
    } catch {
      window.prompt('Copy this and paste it as a bookmark URL:', this.bookmarkletCode);
    }
  }

  sendToExtension(): void {
    this.detectExtension();
    // Sent as a JSON string: objects in a CustomEvent's detail don't reliably
    // cross into the extension's isolated world.
    window.dispatchEvent(new CustomEvent('SYNC_COUPA_EXPENSES', {
      detail: JSON.stringify(this.coupa.buildPayload(this.reports())),
    }));
    if (this.extensionVersion()) {
      this.flash(`Sent ${this.lines().length} lines. In Coupa, click the extension icon, then “Open filler”.`);
    } else {
      this.flash('The Coupa Filler extension isn’t installed in this browser. Use the bookmarklet instead.');
    }
  }

  private detectExtension(): void {
    this.extensionVersion.set(document.documentElement.getAttribute(EXTENSION_ATTR));
  }

  private async loadBookmarklet(): Promise<void> {
    try {
      const res = await fetch('public/coupa-filler.js', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const source = await res.text();
      // Self-contained, so it still works if Coupa's security policy blocks
      // loading scripts from other sites.
      this.bookmarkletCode = 'javascript:' + encodeURIComponent(
        `(function(){${source}\n;window.__coupaFiller&&window.__coupaFiller.open();})();void 0`
      );
      this.bookmarkletHref.set(this.sanitizer.bypassSecurityTrustUrl(this.bookmarkletCode));
    } catch (e) {
      console.error('Could not load coupa-filler.js for the bookmarklet', e);
    }
  }

  private flash(message: string): void {
    this.notice.set(message);
    setTimeout(() => {
      if (this.notice() === message) this.notice.set(null);
    }, 8000);
  }
}
