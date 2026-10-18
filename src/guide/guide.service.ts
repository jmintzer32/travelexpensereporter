import { Injectable, signal } from '@angular/core';

export type GuideSection = 'setup' | 'each-time' | 'teach' | 'help';

// Opens the "How it works" guide from anywhere in the app.
@Injectable({ providedIn: 'root' })
export class GuideService {
  readonly section = signal<GuideSection | null>(null);

  open(section: GuideSection = 'setup'): void {
    this.section.set(section);
  }

  close(): void {
    this.section.set(null);
  }
}
