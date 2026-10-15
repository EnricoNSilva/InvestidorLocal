import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InfoTipComponent } from './info-tip.component';

@Component({
  selector: 'app-kpi-card',
  standalone: true,
  imports: [CommonModule, InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="kpi-card">
      <div class="kpi-label">
        <span>{{ label() }}</span>
        @if (tooltipKey()) {
          <app-info-tip [key]="tooltipKey()"></app-info-tip>
        }
      </div>
      <div class="kpi-value" [ngClass]="valClass()">{{ value() }}</div>
      @if (sub()) {
        <div class="kpi-sub">{{ sub() }}</div>
      }
    </div>
  `,
  styles: [`
    .kpi-card {
      background: var(--bg-card, #141c2e);
      border: 1px solid var(--border-subtle, #1e2c47);
      border-radius: 10px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }

    .kpi-card:hover {
      border-color: var(--border-muted, #2a3b5c);
    }

    .kpi-label {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-secondary, #94a3b8);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .kpi-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary, #f1f5f9);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }

    .kpi-value.pos {
      color: var(--semantic-success, #10b981);
    }

    .kpi-value.neg {
      color: var(--semantic-danger, #ef4444);
    }

    .kpi-sub {
      font-size: 11.5px;
      color: var(--text-muted, #64748b);
      font-variant-numeric: tabular-nums;
    }
  `],
})
export class KpiCardComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly sub = input<string>('');
  readonly valClass = input<string>('');
  readonly tooltipKey = input<string>('');
}
