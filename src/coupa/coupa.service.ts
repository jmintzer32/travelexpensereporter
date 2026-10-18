import { Injectable, signal } from '@angular/core';
import { Trip } from '../models/trip.model';
import { TripReport } from '../models/trip-report.model';
import { EXPENSE_CATEGORIES } from '../models/expense-categories';

export type CoupaDateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YY';

export interface CoupaSettings {
  dateFormat: CoupaDateFormat;
  currency: string;
  // Used for trips that don't have their own business purpose.
  defaultPurpose: string;
  // App category (Airfare, Lodging, ...) -> Coupa Expense Category name, or
  // the start of it. Blank means you pick it in Coupa.
  expenseTypes: Record<string, string>;
}

// A project whose cost code the Coupa filler remembers. `key` ties it to the
// account-picking steps the filler learned for it.
export interface CoupaProject {
  id: string;
  // Company code the project is under, e.g. "4010".
  company: string;
  // Project number, e.g. "12345B1".
  number: string;
  name: string;
  // Usual WBS element, e.g. "01A.021200".
  wbs: string;
}

// What the Coupa filler needs to set a line's Account to a project.
export interface CoupaCostCode {
  key: string;
  label: string;
  company: string;
  number: string;
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
  // Absent when the line keeps Coupa's default account.
  costCode?: CoupaCostCode;
  // The same, for copying by hand in entry mode.
  project: string;
  wbs: string;
}

// One trip becomes one Coupa expense report.
export interface CoupaTrip {
  title: string;
  startDate: string;
  endDate: string;
  // The trip's project, when it has one. Lines can override it.
  project?: CoupaCostCode;
  lines: CoupaLine[];
}

// The JSON copied to the clipboard / sent to the extension.
// coupa-filler.js checks `source` to recognize it.
export interface CoupaPayload {
  source: 'travel-expense-reporter';
  version: 2;
  trips: CoupaTrip[];
}

export const APP_CATEGORIES = EXPENSE_CATEGORIES;

// Coupa asks for a zip code only on these.
const ZIP_CATEGORIES = ['Meals', 'Lodging', 'Entertainment'];

const SETTINGS_KEY = 'coupa.settings.v2';
const PROJECTS_KEY = 'coupa.projects.v1';

const DEFAULT_SETTINGS: CoupaSettings = {
  dateFormat: 'MM/DD/YYYY',
  currency: 'USD',
  defaultPurpose: 'Business travel',
  // Coupa's names, as used on past reports. A start that is unique is
  // enough, since the filler picks the first Coupa choice that begins with it.
  expenseTypes: {
    Airfare: 'Airfare',
    Lodging: 'Lodging',
    Meals: 'Meals - Travel',
    'Rental Car': 'Rental Car',
    Fuel: 'Rental Car - Fuel',
    'Taxi & Ride Share': 'Local Transportation - Taxi',
    'Parking & Tolls': 'Local Transportation - Parking',
    'Travel Fees': 'Travel Fees',
    Supplies: 'Jobsite Supplies',
    Other: '',
    // Categories from reports generated before the list above.
    Transportation: 'Local Transportation - Taxi',
    Entertainment: '',
  },
};

@Injectable({ providedIn: 'root' })
export class CoupaService {
  readonly settings = signal<CoupaSettings>(this.loadSettings());
  readonly projects = signal<CoupaProject[]>(this.loadProjects());

  constructor() {
    // Keep in step with projects added in another tab of this site.
    window.addEventListener('storage', event => {
      if (event.key === PROJECTS_KEY) this.projects.set(this.loadProjects());
    });
  }

  addProject(company: string, number: string, name: string, wbs: string): CoupaProject {
    const project: CoupaProject = {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      company: company.trim(),
      number: number.trim(),
      name: name.trim(),
      wbs: wbs.trim() || DEFAULT_WBS,
    };
    this.saveProjects([...this.projects(), project]);
    return project;
  }

  // Adds a project for each cost code like "4010-Project WBS-12345B1-01A.021200"
  // (optionally followed by a name) not already in the list, and names
  // listed projects that have no name yet. Returns the projects added.
  addProjectsFromCostCodes(text: string): CoupaProject[] {
    const added: CoupaProject[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /(\d{3,5})\s*-\s*Project WBS\s*-\s*([A-Za-z0-9]+)-([A-Za-z0-9.]+)\s*[-–,:]?\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const [, company, number, wbs, name] = match;
      const existing = this.projects().find(p => p.number.toLowerCase() === number.toLowerCase());
      if (existing) {
        if (!existing.name && name.trim()) this.updateProject(existing.id, { name: name.trim() });
        continue;
      }
      added.push(this.addProject(company, number, name.trim(), wbs));
    }
    return added;
  }

  // The Coupa Filler opens this site with "#coupa-projects=<cost codes>" to add
  // projects picked in Coupa. Returns the projects added, or null when the
  // address carried none.
  importProjectsFromAddress(): CoupaProject[] | null {
    const match = /^#coupa-projects=(.*)$/.exec(location.hash);
    if (!match) return null;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      return this.addProjectsFromCostCodes(decodeURIComponent(match[1]));
    } catch {
      return [];
    }
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
      const tripProject = this.projects().find(p => p.id === trip?.projectId);
      const tripCode = tripProject ? costCode(tripProject, trip?.wbs) : undefined;
      return {
        title: trip?.reportTitle || defaultReportTitle(report.trip.startDate),
        startDate: report.trip.startDate,
        endDate: report.trip.endDate,
        project: tripCode,
        lines: report.expenses.map(e => {
          const lineProject = e.projectId ? this.projects().find(p => p.id === e.projectId) : undefined;
          const code = lineProject ? costCode(lineProject) : tripCode;
          return {
            date: formatDate(e.date, s.dateFormat),
            expenseType: e.category in s.expenseTypes ? s.expenseTypes[e.category] : e.category,
            merchant: e.merchant,
            amount: e.amount.toFixed(2),
            currency: s.currency,
            description: e.description,
            purpose,
            zipCode: ZIP_CATEGORIES.includes(e.category) && e.zipCode && e.zipCode !== 'N/A' ? e.zipCode : '',
            category: e.category,
            costCode: code,
            project: code ? code.label : '',
            wbs: code ? code.wbs : '',
          };
        }),
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

export const DEFAULT_WBS = '01A.021200';

// The project number is what Coupa knows it by; fall back to the name.
function costCode(p: CoupaProject, wbs?: string): CoupaCostCode {
  return {
    key: (p.number || p.name).trim().toLowerCase(),
    label: projectLabel(p),
    company: p.company || '',
    number: p.number,
    wbs: wbs || p.wbs,
  };
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
