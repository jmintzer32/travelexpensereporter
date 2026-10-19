import { Injectable, inject, signal } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';

// Builds the "Coupa Filler" bookmarklet from public/coupa-filler.js, for the
// drag-to-bookmarks button in the Coupa panel and in the guide.
@Injectable({ providedIn: 'root' })
export class BookmarkletService {
  private readonly sanitizer = inject(DomSanitizer);

  readonly href = signal<SafeUrl | null>(null);
  // The filler's VERSION, shown so you can tell whether your bookmark is current.
  readonly version = signal('');
  private code = '';

  constructor() {
    this.load();
  }

  // Copies the bookmarklet so it can be pasted as a bookmark's URL.
  async copyCode(): Promise<void> {
    if (!this.code) return;
    try {
      await navigator.clipboard.writeText(this.code);
    } catch {
      window.prompt('Copy this and paste it as a bookmark URL:', this.code);
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('public/coupa-filler.js', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const source = await res.text();
      // Self-contained, so it still works if Coupa's security policy blocks
      // loading scripts from other sites.
      // The filler links back here to add projects picked in Coupa.
      const appUrl = JSON.stringify(document.baseURI);
      this.code = 'javascript:' + encodeURIComponent(
        `(function(){window.__coupaFillerAppUrl=${appUrl};${source}\n;window.__coupaFiller&&window.__coupaFiller.open();})();void 0`
      );
      this.version.set(/VERSION = '([^']+)'/.exec(source)?.[1] ?? '');
      this.href.set(this.sanitizer.bypassSecurityTrustUrl(this.code));
    } catch (e) {
      console.error('Could not load coupa-filler.js for the bookmarklet', e);
    }
  }
}
