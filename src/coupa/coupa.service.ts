import { Injectable, signal } from '@angular/core';
import { TripReport } from '../models/trip-report.model';

export type CoupaDateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YY';

export interface CoupaSettings {
  dateFormat: CoupaDateFormat;
  currency: string;
  // App category (Airfare, Lodging, ...) -> exact Coupa expense type name.
  expenseTypes: Record<string, string>;
}

// One expense line, already formatted exactly as it should be typed into Coupa.
export interface CoupaLine {
  date: string;
  expenseType: string;
  merchant: string;
  amount: string;
  currency: string;
  description: string;
  zipCode: string;
  category: string;
}

// The JSON copied to the clipboard / sent to the extension.
// coupa-filler.js checks `source` to recognize it.
export interface CoupaPayload {
  source: 'travel-expense-reporter';
  version: 1;
  lines: CoupaLine[];
}

export const APP_CATEGORIES = ['Airfare', 'Lodging', 'Meals', 'Transportation', 'Entertainment', 'Other'];

const SETTINGS_KEY = 'coupa.settings.v1';

const DEFAULT_SETTINGS: CoupaSettings = {
  dateFormat: 'MM/DD/YYYY',
  currency: 'USD',
  expenseTypes: {
    Airfare: 'Airfare',
    Lodging: 'Hotel',
    Meals: 'Meals',
    Transportation: 'Ground Transportation',
    Entertainment: 'Entertainment',
    Other: 'Other',
  },
};

@Injectable({ providedIn: 'root' })
export class CoupaService {
  readonly settings = signal<CoupaSettings>(this.loadSettings());

  updateSettings(patch: Partial<CoupaSettings>): void {
    this.settings.update(s => ({ ...s, ...patch }));
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings()));
    } catch {
      // Storage blocked: settings still apply for this visit.
    }
  }

  setExpenseType(category: string, coupaType: string): void {
    this.updateSettings({ expenseTypes: { ...this.settings().expenseTypes, [category]: coupaType } });
  }

  resetSettings(): void {
    this.updateSettings(structuredClone(DEFAULT_SETTINGS));
  }

  buildLines(reports: TripReport[]): CoupaLine[] {
    const s = this.settings();
    return reports
      .flatMap(r => r.expenses)
      .map(e => ({
        date: formatDate(e.date, s.dateFormat),
        expenseType: s.expenseTypes[e.category] || e.category,
        merchant: e.merchant,
        amount: e.amount.toFixed(2),
        currency: s.currency,
        description: e.description,
        zipCode: e.zipCode && e.zipCode !== 'N/A' ? e.zipCode : '',
        category: e.category,
      }));
  }

  buildPayload(reports: TripReport[]): CoupaPayload {
    return { source: 'travel-expense-reporter', version: 1, lines: this.buildLines(reports) };
  }

  private loadSettings(): CoupaSettings {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (saved) {
        return {
          ...DEFAULT_SETTINGS,
          ...saved,
          expenseTypes: { ...DEFAULT_SETTINGS.expenseTypes, ...saved.expenseTypes },
        };
      }
    } catch {
      // Fall through to defaults.
    }
    return structuredClone(DEFAULT_SETTINGS);
  }
}

// Expense dates come from Gemini as YYYY-MM-DD.
export function formatDate(isoDate: string, format: CoupaDateFormat): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const [, y, m, d] = match;
  switch (format) {
    case 'DD/MM/YYYY': return `${d}/${m}/${y}`;
    case 'YYYY-MM-DD': return `${y}-${m}-${d}`;
    case 'MM/DD/YY': return `${m}/${d}/${y.slice(2)}`;
    default: return `${m}/${d}/${y}`;
  }
}
