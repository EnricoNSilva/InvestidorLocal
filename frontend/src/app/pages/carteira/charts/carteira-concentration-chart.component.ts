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
import { ChartPesoAtivosData } from '../../../core/models/investimento.models';
import { registerCharts } from '../../renda-fixa/charts/chart-registry';
import { chartTheme } from '../../renda-fixa/charts/chart-theme';

@Component({
  selector: 'app-carteira-concentration-chart',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card">
      <div class="chart-header">
        <div class="header-titles">
          <h3 class="chart-title">Top Ativos por Concentração</h3>
          <span class="chart-subtitle">Peso percentual no patrimônio da visão</span>
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
export class CarteiraConcentrationChartComponent {
  readonly data = input.required<ChartPesoAtivosData>();
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

      const hasValues = d.percentual.length > 0 && d.percentual.some((v) => v > 0);
      this.semDados.set(!hasValues);

      if (!c) return;

      c.data.labels = d.labels;
      if (c.data.datasets[0]) {
        c.data.datasets[0].data = d.percentual;
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
            label: 'Peso na Carteira (%)',
            data: d.percentual,
            backgroundColor: '#3b82f6',
            hoverBackgroundColor: '#60a5fa',
            borderRadius: 4,
            borderSkipped: false,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const idx = ctx.dataIndex;
                const pct = Number(ctx.parsed.x) || 0;
                const dAtivos = this.data();
                const valorReais = dAtivos.data[idx] || 0;
                const valStr = `R$ ${valorReais.toLocaleString('pt-BR', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`;
                return ` ${pct.toFixed(2)}% (${valStr})`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: {
              color: theme.borderGrid,
            },
            ticks: {
              color: theme.textSecondary,
              font: { size: 10 },
              callback: (val) => `${val}%`,
            },
            suggestedMax: 20,
          },
          y: {
            grid: {
              display: false,
            },
            ticks: {
              color: theme.textSecondary,
              font: { size: 11, weight: 'bold' },
            },
          },
        },
      },
    };
  }
}
