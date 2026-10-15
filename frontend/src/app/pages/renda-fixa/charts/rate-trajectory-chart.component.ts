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
import { RatePoint } from '../../../core/financial-engine/types';
import { registerCharts } from './chart-registry';
import { chartTheme } from './chart-theme';

export function calcYScale(data: number[]) {
  if (data.length === 0) return { yMin: 0, yMax: 10, stepSize: 1.0 };
  const minVal = Math.min(...data);
  const maxVal = Math.max(...data);
  const spreadRange = maxVal - minVal;
  const desiredSpan = Math.max(spreadRange * 1.3, 2.0);
  const mid = (minVal + maxVal) / 2;

  let yMin = Math.max(0, Math.floor((mid - desiredSpan / 2) * 2) / 2);
  let yMax = Math.ceil((mid + desiredSpan / 2) * 2) / 2;
  if (yMax - yMin < 2.0) {
    yMax = yMin + 2.0;
  }
  const stepSize = yMax - yMin <= 3.0 ? 0.5 : 1.0;
  return { yMin, yMax, stepSize };
}

export function buildRateTrajectoryConfig(
  points: RatePoint[],
  theme = chartTheme()
): ChartConfiguration<'line'> {
  const labels = points.map((p) => p.label);
  const data = points.map((p) => p.ratePct);
  const { yMin, yMax, stepSize } = calcYScale(data);

  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Taxa Projetada',
          data,
          borderColor: theme.primary,
          backgroundColor: theme.primaryBg,
          fill: true,
          tension: 0.15,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `Taxa: IPCA + ${(Number(ctx.parsed.y) || 0).toFixed(2).replace('.', ',')}% a.a.`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: theme.textMuted, maxTicksLimit: 8 },
          grid: { display: false },
        },
        y: {
          min: yMin,
          max: yMax,
          ticks: {
            color: theme.textMuted,
            stepSize,
            callback: (v: any) =>
              (Number(v) || 0).toFixed(2).replace('.', ',') + '%',
          },
          grid: { color: theme.borderGrid },
        },
      },
    },
  };
}

@Component({
  selector: 'app-rate-trajectory-chart',
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
      height: 160px;
      min-width: 0;
    }
    canvas {
      display: block;
      width: 100% !important;
      height: 100% !important;
    }
  `],
})
export class RateTrajectoryChartComponent {
  readonly points = input.required<RatePoint[]>();
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  private readonly zone = inject(NgZone);
  chart?: Chart<'line'>;

  constructor() {
    registerCharts();

    afterNextRender(() => {
      const cv = this.canvas()?.nativeElement;
      if (cv && !this.chart) {
        const theme = chartTheme();
        const ctx = cv.getContext('2d');
        let bg: any = theme.primaryBg;
        if (ctx) {
          const grad = ctx.createLinearGradient(0, 0, 0, 160);
          grad.addColorStop(0, 'rgba(59, 130, 246, 0.35)');
          grad.addColorStop(1, 'rgba(59, 130, 246, 0.02)');
          bg = grad;
        }
        this.zone.runOutsideAngular(() => {
          const cfg = buildRateTrajectoryConfig(this.points(), theme);
          if (cfg.data.datasets[0]) {
            cfg.data.datasets[0].backgroundColor = bg;
          }
          this.chart = new Chart(cv, cfg);
        });
      }
    });

    effect(() => {
      const pts = this.points();
      const c = this.chart;
      if (!c) return;

      const labels = pts.map((p) => p.label);
      const data = pts.map((p) => p.ratePct);
      const { yMin, yMax, stepSize } = calcYScale(data);

      c.data.labels = labels;
      if (c.data.datasets[0]) {
        c.data.datasets[0].data = data;
      }
      if (c.options.scales?.['y']) {
        c.options.scales['y'].min = yMin;
        c.options.scales['y'].max = yMax;
        if (c.options.scales['y'].ticks) {
          (c.options.scales['y'].ticks as any).stepSize = stepSize;
        }
      }

      this.zone.runOutsideAngular(() => c.update('none'));
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }
}
