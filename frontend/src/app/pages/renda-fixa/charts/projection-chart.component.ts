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
  viewChild,
} from '@angular/core';
import { Chart, ChartConfiguration } from 'chart.js';
import { ProjectionSeries } from '../../../core/models/renda-fixa.models';
import { registerCharts } from './chart-registry';
import { chartTheme } from './chart-theme';

export const SERIES_ORDER = ['alvo', 'carrego', 'cdi', 'queda5', 'alta8'] as const;

export function buildProjectionConfig(
  data: ProjectionSeries,
  theme = chartTheme()
): ChartConfiguration<'line'> {
  return {
    type: 'line',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: 'Cenário Alvo',
          data: [...(data.series?.alvo ?? [])],
          borderColor: theme.primary,
          borderWidth: 3,
          pointRadius: 0,
        },
        {
          label: 'Carrego Puro (Taxa de Compra)',
          data: [...(data.series?.carrego ?? [])],
          borderColor: theme.whiteDashed,
          borderDash: [5, 4],
          borderWidth: 2,
          pointRadius: 0,
        },
        {
          label: 'Benchmark 100% CDI',
          data: [...(data.series?.cdi ?? [])],
          borderColor: theme.cdi,
          borderDash: [3, 3],
          borderWidth: 2,
          pointRadius: 0,
        },
        {
          label: 'Queda de Juros (IPCA + 5,0%)',
          data: [...(data.series?.queda5 ?? [])],
          borderColor: theme.success,
          borderWidth: 1.5,
          pointRadius: 0,
        },
        {
          label: 'Estresse / Alta (IPCA + 8,0%)',
          data: [...(data.series?.alta8 ?? [])],
          borderColor: theme.danger,
          borderWidth: 1.5,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: theme.textSecondary, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: R$ ${(Number(ctx.parsed.y) || 0).toLocaleString('pt-BR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: theme.textMuted },
          grid: { color: theme.borderGrid },
        },
        y: {
          ticks: {
            color: theme.textMuted,
            callback: (v: any) =>
              'R$ ' + (Number(v) / 1000).toLocaleString('pt-BR') + ' mil',
          },
          grid: { color: theme.borderGrid },
        },
      },
    },
  };
}

@Component({
  selector: 'app-projection-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-box">
      <canvas #cv></canvas>
    </div>
  `,
  styles: [`
    .chart-box {
      position: relative;
      width: 100%;
      height: 380px;
      min-width: 0;
    }
    canvas {
      display: block;
      width: 100% !important;
      height: 100% !important;
    }
  `],
})
export class ProjectionChartComponent {
  readonly data = input.required<ProjectionSeries>();
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  private readonly zone = inject(NgZone);
  chart?: Chart<'line'>;

  constructor() {
    registerCharts();

    afterNextRender(() => {
      const cv = this.canvas()?.nativeElement;
      if (cv && !this.chart) {
        this.zone.runOutsideAngular(() => {
          this.chart = new Chart(cv, buildProjectionConfig(this.data(), chartTheme()));
        });
      }
    });

    effect(() => {
      const d = this.data();
      const c = this.chart;
      if (!c) return;
      c.data.labels = d.labels;
      SERIES_ORDER.forEach((k, i) => {
        if (c.data.datasets[i]) {
          c.data.datasets[i].data = d.series[k] ?? [];
        }
      });
      this.zone.runOutsideAngular(() => c.update('none'));
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }
}
