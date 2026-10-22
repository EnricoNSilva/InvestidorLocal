import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  NgZone,
  DestroyRef,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration } from 'chart.js';
import { ChartAlocacaoData } from '../../../core/models/investimento.models';
import { registerCharts } from '../../renda-fixa/charts/chart-registry';
import { chartTheme } from '../../renda-fixa/charts/chart-theme';

export const CLASSE_PALETTE: Record<string, string> = {
  Acao: '#3b82f6',
  FII: '#8b5cf6',
  Cripto: '#f59e0b',
  RendaFixa: '#10b981',
  Outros: '#64748b',
};

export const SETOR_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#eab308',
  '#6366f1',
  '#14b8a6',
  '#f97316',
  '#a855f7',
  '#64748b',
];

@Component({
  selector: 'app-carteira-allocation-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card">
      <div class="chart-header">
        <div class="header-titles">
          <h3 class="chart-title">Alocação da Carteira</h3>
          <span class="chart-subtitle">Distribuição do patrimônio a mercado</span>
        </div>
        <div class="toggle-group">
          <button
            type="button"
            class="toggle-btn"
            [class.active]="modo() === 'classe'"
            (click)="setModo('classe')"
          >
            Classe
          </button>
          <button
            type="button"
            class="toggle-btn"
            [class.active]="modo() === 'setor'"
            (click)="setModo('setor')"
          >
            Setor
          </button>
        </div>
      </div>

      <div class="canvas-container">
        <canvas #cv></canvas>
        <div *ngIf="semDados()" class="empty-overlay">
          <span>Nenhum ativo com valor no filtro selecionado</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .chart-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      display: flex;
      flex-direction: column;
      height: 100%;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .chart-title {
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--text-main);
      margin: 0;
    }
    .chart-subtitle {
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .toggle-group {
      display: flex;
      background: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 2px;
    }
    .toggle-btn {
      background: none;
      border: none;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.3rem 0.7rem;
      color: var(--text-muted);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      &:hover {
        color: var(--text-main);
      }
      &.active {
        background: var(--primary);
        color: #ffffff;
      }
    }
    .canvas-container {
      position: relative;
      width: 100%;
      height: 250px;
      min-height: 250px;
    }
    canvas {
      display: block;
      width: 100% !important;
      height: 100% !important;
    }
    .empty-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 0.85rem;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 8px;
    }
  `],
})
export class CarteiraAllocationChartComponent {
  readonly data = input.required<ChartAlocacaoData>();
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  readonly modo = signal<'classe' | 'setor'>('classe');

  private readonly zone = inject(NgZone);
  private chart?: Chart<'doughnut'>;

  readonly semDados = signal<boolean>(false);

  constructor() {
    registerCharts();

    afterNextRender(() => {
      const cv = this.canvas()?.nativeElement;
      if (cv && !this.chart) {
        this.zone.runOutsideAngular(() => {
          this.chart = new Chart(cv, this.buildConfig());
        });
      }
    });

    effect(() => {
      const aloc = this.data();
      const m = this.modo();
      const current = m === 'classe' ? aloc.porClasse : aloc.porSetor;
      const c = this.chart;

      const hasValues = current.data.length > 0 && current.data.some((v) => v > 0);
      this.semDados.set(!hasValues);

      if (!c) return;

      c.data.labels = current.labels;
      if (c.data.datasets[0]) {
        c.data.datasets[0].data = current.data;
        c.data.datasets[0].backgroundColor = this.getColors(current.labels, m);
      }
      this.zone.runOutsideAngular(() => c.update('none'));
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }

  setModo(modo: 'classe' | 'setor'): void {
    this.modo.set(modo);
  }

  private getColors(labels: string[], modo: 'classe' | 'setor'): string[] {
    if (modo === 'classe') {
      return labels.map((l) => CLASSE_PALETTE[l] || CLASSE_PALETTE['Outros']);
    }
    return labels.map((_, i) => SETOR_PALETTE[i % SETOR_PALETTE.length]);
  }

  private buildConfig(): ChartConfiguration<'doughnut'> {
    const aloc = this.data();
    const m = this.modo();
    const current = m === 'classe' ? aloc.porClasse : aloc.porSetor;
    const theme = chartTheme();

    return {
      type: 'doughnut',
      data: {
        labels: current.labels,
        datasets: [
          {
            data: current.data,
            backgroundColor: this.getColors(current.labels, m),
            borderWidth: 2,
            borderColor: '#141c2e',
            hoverOffset: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: theme.textSecondary,
              font: { size: 11 },
              padding: 10,
              boxWidth: 12,
              boxHeight: 12,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = Number(ctx.parsed) || 0;
                const dataArray = (ctx.dataset.data as number[]) || [];
                const total = dataArray.reduce((acc, curr) => acc + (Number(curr) || 0), 0);
                const pct = total > 0 ? (val / total) * 100 : 0;
                const valStr = `R$ ${val.toLocaleString('pt-BR', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`;
                return ` ${ctx.label}: ${valStr} (${pct.toFixed(1)}%)`;
              },
            },
          },
        },
      },
    };
  }
}
