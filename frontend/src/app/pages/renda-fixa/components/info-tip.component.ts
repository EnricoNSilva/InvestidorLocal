import { Component, ChangeDetectionStrategy, input, signal, computed, HostListener } from '@angular/core';
import { GLOSSARY } from '../content/glossary';

@Component({
  selector: 'app-info-tip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tipText()) {
      <span class="infotip-container" [class.open]="isOpen()">
        <button
          type="button"
          class="infotip-trigger"
          aria-label="Informações e conceito da métrica"
          (click)="toggle($event)"
        >?</button>
        <span class="infotip-popup" role="tooltip">{{ tipText() }}</span>
      </span>
    }
  `,
  styles: [`
    .infotip-container {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 6px;
      vertical-align: middle;
    }

    .infotip-trigger {
      width: 17px;
      height: 17px;
      border-radius: 50%;
      border: 1px solid var(--border-muted, #2a3b5c);
      background: var(--bg-elevated, #182238);
      color: var(--text-muted, #64748b);
      font-size: 10px;
      font-weight: 700;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      line-height: 1;
      padding: 0;
      transition: all 0.15s ease;
      outline: none;
    }

    .infotip-trigger:hover,
    .infotip-trigger:focus-visible,
    .infotip-container.open .infotip-trigger {
      color: var(--brand-primary, #3b82f6);
      border-color: var(--brand-primary, #3b82f6);
      background: var(--bg-card, #141c2e);
      box-shadow: 0 0 8px rgba(59, 130, 246, 0.25);
    }

    .infotip-popup {
      display: none;
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      background: #182238;
      color: #f1f5f9;
      border: 1px solid var(--border-subtle, #1e2c47);
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 11.5px;
      font-weight: 400;
      line-height: 1.5;
      text-transform: none;
      letter-spacing: normal;
      width: max-content;
      max-width: 270px;
      white-space: normal;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.7);
      z-index: 1000;
      pointer-events: none;
    }

    .infotip-popup::after {
      content: "";
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      border-width: 6px;
      border-style: solid;
      border-color: #182238 transparent transparent transparent;
    }

    :host-context(.kpi-card) .infotip-popup {
      right: -8px;
      left: auto;
      transform: none;
    }

    :host-context(.kpi-card) .infotip-popup::after {
      right: 12px;
      left: auto;
      transform: none;
    }

    .infotip-container:hover .infotip-popup,
    .infotip-container.open .infotip-popup,
    .infotip-trigger:focus-visible + .infotip-popup {
      display: block;
      animation: tooltipFadeIn 0.16s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes tooltipFadeIn {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `],
})
export class InfoTipComponent {
  readonly key = input<string>('');
  readonly text = input<string>('');
  readonly isOpen = signal(false);

  readonly tipText = computed(() => {
    const k = this.key();
    if (k && GLOSSARY[k]) return GLOSSARY[k];
    if (this.text()) return this.text();
    return k || '';
  });

  toggle(e: Event): void {
    e.stopPropagation();
    this.isOpen.update((v) => !v);
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
    }
  }
}
