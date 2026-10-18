import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { BookmarkletService } from '../coupa/bookmarklet.service';
import { GuideSection, GuideService } from './guide.service';

// Step-by-step "How it works" guide: setup, every report, Teach, and fixes.
@Component({
  selector: 'app-guide',
  templateUrl: './guide.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [MatIconModule],
})
export class GuideComponent {
  private readonly guide = inject(GuideService);
  private readonly bookmarklet = inject(BookmarkletService);

  readonly section = this.guide.section;
  readonly bookmarkletHref = this.bookmarklet.href;
  readonly bookmarkletVersion = this.bookmarklet.version;
  readonly copied = signal(false);

  readonly sections: { id: GuideSection; label: string; icon: string }[] = [
    { id: 'setup', label: 'One-time setup', icon: 'build' },
    { id: 'each-time', label: 'Every report', icon: 'repeat' },
    { id: 'teach', label: 'Teach cost codes', icon: 'school' },
    { id: 'help', label: 'If something’s off', icon: 'help_outline' },
  ];

  show(section: GuideSection): void {
    this.guide.open(section);
  }

  close(): void {
    this.guide.close();
  }

  async copyBookmarklet(): Promise<void> {
    await this.bookmarklet.copyCode();
    this.copied.set(true);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }
}
