import { Injectable, signal } from '@angular/core';
import { Trip } from '../models/trip.model';
import { TripReport } from '../models/trip-report.model';

export type CoupaDateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YY';

export interface CoupaSettings {
  dateFormat: CoupaDateFormat;
  currency: string;
  // Used for trips that don't have their own business purpose.
  defaultPurpose: string;
  // App category (Airfare, Lodging, ...) -> exact Coupa expense category name.
  expenseTypes: Record<string, string>;
}

// A project whose cost code the Coupa filler remembers. `key` ties it to the
// account-picking steps the filler learned for it.
export interface CoupaProject {
  id: string;
  number: string;
  name: string;
  // Usual WBS element, e.g. "Travel".
  wbs: string;
}

// One expense line, already formatted exactly as it should be typed into Coupa.
export interface CoupaLine {
  date: string;
  expenseType: string;
  merchant: string;
  amount: string;
  currency: string;
  description: string;
  purpose: string;
  zipCode: string;
  category: string;
  // For copying by hand in entry mode; the filler uses CoupaTrip.project.
  project: string;
  wbs: string;
}

// One trip becomes one Coupa expense report.
export interface CoupaTrip {
  title: string;
  startDate: string;
  endDate: string;
  // Absent when lines keep Coupa's default account.
  project?: { key: string; label: string; wbs: string };
  lines: CoupaLine[];
}

// The JSON copied to the clipboard / sent to the extension.
// coupa-filler.js checks `source` to recognize it.
export interface CoupaPayload {
  source: 'travel-expense-reporter';
  version: 2;
  trips: CoupaTrip[];
}

export const APP_CATEGORIES = ['Airfare', 'Lodging', 'Meals', 'Transportation', 'Entertainment', 'Other'];

// Coupa asks for a zip code only on these.
const ZIP_CATEGORIES = ['Meals', 'Lodging', 'Entertainment'];

const SETTINGS_KEY = 'coupa.settings.v1';
const PROJECTS_KEY = 'coupa.projects.v1';

const DEFAULT_SETTINGS: CoupaSettings = {
  dateFormat: 'MM/DD/YYYY',
  currency: 'USD',
  defaultPurpose: 'Business travel',
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
  readonly projects = signal<CoupaProject[]>(this.loadProjects());

  addProject(number: string, name: string, wbs: string): CoupaProject {
    const project: CoupaProject = {
      id: `p${Date.now().toString(36)}`,
      number: number.trim(),
      name: name.trim(),
      wbs: wbs.trim() || 'Travel',
    };
    this.saveProjects([...this.projects(), project]);
    return project;
  }

  updateProject(id: string, patch: Partial<Omit<CoupaProject, 'id'>>): void {
    this.saveProjects(this.projects().map(p => (p.id === id ? { ...p, ...patch } : p)));
  }

  removeProject(id: string): void {
    this.saveProjects(this.projects().filter(p => p.id !== id));
  }

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

  // `trips` supplies the purpose and report name, which can be edited after
  // the reports were generated.
  buildTrips(reports: TripReport[], trips: Trip[]): CoupaTrip[] {
    const s = this.settings();
    return reports.map(report => {
      const trip = trips.find(t => t.id === report.trip.id);
      const purpose = trip?.purpose || s.defaultPurpose;
      const project = this.projects().find(p => p.id === trip?.projectId);
      const wbs = project ? trip?.wbs || project.wbs : '';
      return {
        title: trip?.reportTitle || defaultReportTitle(report.trip.startDate),
        startDate: report.trip.startDate,
        endDate: report.trip.endDate,
        project: project ? { key: projectKey(project), label: projectLabel(project), wbs } : undefined,
        lines: report.expenses.map(e => ({
          date: formatDate(e.date, s.dateFormat),
          expenseType: s.expenseTypes[e.category] || e.category,
          merchant: e.merchant,
          amount: e.amount.toFixed(2),
          currency: s.currency,
          description: e.description,
          purpose,
          zipCode: ZIP_CATEGORIES.includes(e.category) && e.zipCode && e.zipCode !== 'N/A' ? e.zipCode : '',
          category: e.category,
          project: project ? projectLabel(project) : '',
          wbs,
        })),
      };
    });
  }

  buildPayload(reports: TripReport[], trips: Trip[]): CoupaPayload {
    return {
      source: 'travel-expense-reporter',
      version: 2,
      trips: this.buildTrips(reports, trips).filter(t => t.lines.length > 0),
    };
  }

  private saveProjects(projects: CoupaProject[]): void {
    this.projects.set(projects);
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    } catch {
      // Storage blocked: projects still apply for this visit.
    }
  }

  private loadProjects(): CoupaProject[] {
    try {
      const saved = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
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

export function projectLabel(p: CoupaProject): string {
  return [p.number, p.name].filter(Boolean).join(' – ');
}

// The project number is what Coupa knows it by; fall back to the name.
function projectKey(p: CoupaProject): string {
  return (p.number || p.name).trim().toLowerCase();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Matches the names already used on this account's Coupa reports.
export function defaultReportTitle(isoStartDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoStartDate || '');
  if (!match) return 'Trip';
  const [, y, m, d] = match;
  return `Trip starting ${MONTHS[Number(m) - 1]} ${d}, ${y}`;
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
