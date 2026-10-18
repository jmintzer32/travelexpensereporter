import { ChangeDetectionStrategy, Component, HostListener, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CoupaLine, CoupaTrip } from './coupa.service';

interface EntryField {
  key: keyof CoupaLine;
  label: string;
}

// Same order as the fields on Coupa's expense line form.
const FIELDS: EntryField[] = [
  { key: 'expenseType', label: 'Expense Category' },
  { key: 'date', label: 'Expense Date' },
  { key: 'amount', label: 'Total' },
  { key: 'description', label: 'Description' },
  { key: 'merchant', label: 'Merchant' },
  { key: 'purpose', label: 'Business Purpose' },
  { key: 'zipCode', label: 'Zip Code' },
  { key: 'project', label: 'Project' },
  { key: 'wbs', label: 'WBS Element' },
];

interface EntryLine extends CoupaLine {
  tripIndex: number;
  tripTitle: string;
}

const PROGRESS_KEY = 'coupa.entryProgress.v1';

// Click-to-copy view for typing lines into Coupa by hand, one field at a time.
@Component({
  selector: 'app-coupa-entry-mode',
  templateUrl: './coupa-entry-mode.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [MatIconModule],
})
export class CoupaEntryModeComponent {
  readonly trips = input.required<CoupaTrip[]>();
  readonly lines = computed<EntryLine[]>(() =>
    this.trips().flatMap((t, tripIndex) => t.lines.map(l => ({ ...l, tripIndex, tripTitle: t.title })))
  );
  readonly closed = output<void>();

  readonly current = signal(0);
  // Index of the field that the next Enter/Space press will copy.
  readonly nextField = signal(0);
  readonly copiedKey = signal<string | null>(null);
  readonly done = signal<Set<number>>(new Set());

  readonly line = computed(() => this.lines()[this.current()]);
  readonly fields = computed(() => {
    const line = this.line();
    return line ? FIELDS.filter(f => line[f.key]) : [];
  });
  readonly doneCount = computed(() => this.done().size);

  private progressKey = '';

  ngOnInit(): void {
    // Progress survives a refresh, as long as the lines are the same.
    this.progressKey = this.lines().map(l => `${l.date}|${l.merchant}|${l.amount}`).join(';');
    try {
      const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null');
      if (saved?.key === this.progressKey) {
        this.done.set(new Set<number>(saved.done));
        this.select(this.firstOpen(0));
      }
    } catch {
      // Start fresh.
    }
  }

  select(index: number): void {
    if (index < 0 || index >= this.lines().length) return;
    this.current.set(index);
    this.nextField.set(0);
    this.copiedKey.set(null);
  }

  // True for the first line of each trip, where the list shows a trip header.
  startsTrip(index: number): boolean {
    const lines = this.lines();
    return index === 0 || lines[index].tripIndex !== lines[index - 1].tripIndex;
  }

  async copy(field: EntryField, index: number): Promise<void> {
    const value = this.line()?.[field.key] ?? '';
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.prompt(`Copy ${field.label}:`, value);
    }
    this.copiedKey.set(field.key);
    const fields = this.fields();
    if (index >= fields.length - 1) {
      this.nextField.set(fields.length);
    } else {
      this.nextField.set(index + 1);
    }
  }

  copyNext(): void {
    const fields = this.fields();
    const i = this.nextField();
    if (i < fields.length) {
      this.copy(fields[i], i);
    } else {
      this.markDoneAndAdvance();
    }
  }

  markDoneAndAdvance(): void {
    this.setDone(this.current(), true);
    this.select(this.firstOpen(this.current() + 1));
  }

  toggleDone(index: number): void {
    this.setDone(index, !this.done().has(index));
  }

  isDone(index: number): boolean {
    return this.done().has(index);
  }

  resetProgress(): void {
    this.done.set(new Set());
    this.saveProgress();
    this.select(0);
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.copyNext();
    } else if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      this.select(this.current() + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      this.select(this.current() - 1);
    } else if (event.key === 'Escape') {
      this.closed.emit();
    } else if (/^[1-9]$/.test(event.key)) {
      const i = Number(event.key) - 1;
      const field = this.fields()[i];
      if (field) this.copy(field, i);
    }
  }

  private firstOpen(from: number): number {
    const total = this.lines().length;
    for (let i = from; i < total; i++) if (!this.done().has(i)) return i;
    for (let i = 0; i < from && i < total; i++) if (!this.done().has(i)) return i;
    return Math.min(from, total - 1);
  }

  private setDone(index: number, value: boolean): void {
    const next = new Set(this.done());
    if (value) next.add(index); else next.delete(index);
    this.done.set(next);
    this.saveProgress();
  }

  private saveProgress(): void {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify({ key: this.progressKey, done: [...this.done()] }));
    } catch {
      // Progress just won't survive a refresh.
    }
  }
}
