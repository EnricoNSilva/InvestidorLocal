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
import { ChartRankingProventosData } from '../../../core/models/investimento.models';
import { registerCharts } from '../../renda-fixa/charts/chart-registry';
import { chartTheme } from '../../renda-fixa/charts/chart-theme';

@Component({
  selector: 'app-carteira-proventos-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card">
      <div class="chart-header">
        <div class="header-titles">
          <h3 class="chart-title">{{ titulo() }}</h3>
          <span class="chart-subtitle">{{ subtitulo() }}</span>
        </div>
      </div>

      <div class="canvas-container">
        <canvas #cv></canvas>
        <div *ngIf="semDados()" class="empty-overlay">
          <span>Nenhum provento registrado no filtro selecionado</span>
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
      margin-bottom: 1rem;
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
export class CarteiraProventosChartComponent {
  readonly data = input.required<ChartRankingProventosData>();
  readonly titulo = input<string>('Top Geradores de Proventos & YoC');
  readonly subtitulo = input<string>('Total acumulado recebido (R$) vs. Yield on Cost (%)');
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');

  private readonly zone = inject(NgZone);
  private chart?: Chart<'bar'>;

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
      const d = this.data();
      const c = this.chart;

      const hasValues = d.proventos.length > 0 && d.proventos.some((v) => v > 0);
      this.semDados.set(!hasValues);

      if (!c) return;

      c.data.labels = d.labels;
      if (c.data.datasets[0]) {
        c.data.datasets[0].data = d.proventos;
      }
      if (c.data.datasets[1]) {
        c.data.datasets[1].data = d.yoc;
      }
      this.zone.runOutsideAngular(() => c.update('none'));
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }

  private buildConfig(): ChartConfiguration<'bar'> {
    const d = this.data();
    const theme = chartTheme();

    return {
      type: 'bar',
      data: {
        labels: d.labels,
        datasets: [
          {
            label: 'Proventos (R$)',
            data: d.proventos,
            backgroundColor: '#10b981',
            hoverBackgroundColor: '#34d399',
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'Yield on Cost (%)',
            data: d.yoc,
            backgroundColor: '#8b5cf6',
            hoverBackgroundColor: '#a78bfa',
            borderRadius: 4,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: theme.textSecondary,
              font: { size: 11 },
              boxWidth: 12,
              boxHeight: 12,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = Number(ctx.parsed.y) || 0;
                if (ctx.datasetIndex === 0) {
                  const valStr = `R$ ${val.toLocaleString('pt-BR', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`;
                  return ` Proventos: ${valStr}`;
                } else {
                  return ` YoC: ${val.toFixed(2)}%`;
                }
              },
            },
          },
        },
        scales: {
          x: {
            grid: {
              display: false,
            },
            ticks: {
              color: theme.textSecondary,
              font: { size: 10, weight: 'bold' },
            },
          },
          y: {
            type: 'linear',
            position: 'left',
            grid: {
              color: theme.borderGrid,
            },
            ticks: {
              color: theme.textSecondary,
              font: { size: 10 },
              callback: (val) => {
                const num = Number(val);
                if (num >= 1000) return `R$ ${(num / 1000).toFixed(1)}k`;
                return `R$ ${num}`;
              },
            },
          },
          y1: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              color: theme.textSecondary,
              font: { size: 10 },
              callback: (val) => `${val}%`,
            },
          },
        },
      },
    };
  }
}
