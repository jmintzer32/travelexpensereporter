import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { Trip } from '../models/trip.model';
import { TripReport } from '../models/trip-report.model';
import { APP_CATEGORIES, CoupaDateFormat, CoupaService } from './coupa.service';
import { CoupaEntryModeComponent } from './coupa-entry-mode.component';
import { BookmarkletService } from './bookmarklet.service';
import { GuideSection, GuideService } from '../guide/guide.service';

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
  private readonly bookmarklet = inject(BookmarkletService);
  private readonly guide = inject(GuideService);

  readonly reports = input.required<TripReport[]>();
  readonly trips = input.required<Trip[]>();

  readonly settings = this.coupa.settings;
  readonly projects = this.coupa.projects;
  readonly categories = APP_CATEGORIES;
  readonly dateFormats: CoupaDateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YY'];

  readonly coupaTrips = computed(() => this.coupa.buildTrips(this.reports(), this.trips()).filter(t => t.lines.length > 0));
  readonly lineCount = computed(() => this.coupaTrips().reduce((n, t) => n + t.lines.length, 0));
  // Meal and lodging lines Coupa will reject for having no zip code.
  readonly missingZips = computed(() => this.reports()
    .flatMap(r => r.expenses)
    .filter(e => ['Meals', 'Lodging'].includes(e.category) && !/^\d{5}$/.test(e.zipCode || '')).length);
  readonly entryModeOpen = signal(false);
  readonly showSettings = signal(false);
  readonly showBookmarkletHelp = signal(false);
  readonly notice = signal<string | null>(null);
  readonly extensionVersion = signal<string | null>(null);
  readonly bookmarkletHref = this.bookmarklet.href;
  readonly bookmarkletVersion = this.bookmarklet.version;

  constructor() {
    // The extension's content script runs after the page loads; check again shortly.
    this.detectExtension();
    setTimeout(() => this.detectExtension(), 1500);
  }

  setDateFormat(format: CoupaDateFormat): void {
    this.coupa.updateSettings({ dateFormat: format });
  }

  setDefaultPurpose(purpose: string): void {
    this.coupa.updateSettings({ defaultPurpose: purpose.trim() });
  }

  setCurrency(currency: string): void {
    this.coupa.updateSettings({ currency: currency.trim().toUpperCase() });
  }

  setExpenseType(category: string, coupaType: string): void {
    this.coupa.setExpenseType(category, coupaType.trim());
  }

  importCostCodes(text: string): void {
    const added = this.coupa.addProjectsFromCostCodes(text).length;
    this.flash(added ? `Added ${added} ${added === 1 ? 'project' : 'projects'}. Give them names so they’re easy to pick.` : 'No new projects found. Cost codes look like 4010-Project WBS-12345B1-01A.021200.');
  }

  updateProject(id: string, field: 'company' | 'number' | 'name' | 'wbs', value: string): void {
    this.coupa.updateProject(id, { [field]: value.trim() });
  }

  removeProject(id: string): void {
    this.coupa.removeProject(id);
  }

  resetSettings(): void {
    this.coupa.resetSettings();
  }

  async copyForBookmarklet(): Promise<void> {
    const json = JSON.stringify(this.payload());
    try {
      await navigator.clipboard.writeText(json);
      this.flash(`Copied ${this.tripSummary()}. In Coupa, click the “Coupa Filler” bookmark and paste.`);
    } catch {
      window.prompt('Copy this, then paste it into the Coupa Filler panel:', json);
    }
  }

  async copyBookmarkletCode(): Promise<void> {
    await this.bookmarklet.copyCode();
    this.flash('Bookmarklet copied. Create a new bookmark and paste it as the URL.');
  }

  openGuide(section: GuideSection): void {
    this.guide.open(section);
  }

  sendToExtension(): void {
    this.detectExtension();
    // Sent as a JSON string: objects in a CustomEvent's detail don't reliably
    // cross into the extension's isolated world.
    window.dispatchEvent(new CustomEvent('SYNC_COUPA_EXPENSES', {
      detail: JSON.stringify(this.payload()),
    }));
    if (this.extensionVersion()) {
      this.flash(`Sent ${this.tripSummary()}. In Coupa, click the extension icon, then “Open filler”.`);
    } else {
      this.flash('The Coupa Filler extension isn’t installed in this browser. Use the bookmarklet instead.');
    }
  }

  private payload() {
    return { ...this.coupa.buildPayload(this.reports(), this.trips()), fillerVersion: this.bookmarklet.version() };
  }

  private tripSummary(): string {
    const trips = this.coupaTrips().length;
    return `${trips} ${trips === 1 ? 'trip' : 'trips'} (${this.lineCount()} lines)`;
  }

  private detectExtension(): void {
    this.extensionVersion.set(document.documentElement.getAttribute(EXTENSION_ATTR));
  }

  private flash(message: string): void {
    this.notice.set(message);
    setTimeout(() => {
      if (this.notice() === message) this.notice.set(null);
    }, 8000);
  }
}
