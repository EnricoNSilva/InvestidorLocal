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
import { AllocationSlice } from '../../../core/models/renda-fixa.models';
import { registerCharts } from './chart-registry';
import { chartTheme } from './chart-theme';

export const ALLOCATION_PALETTE = {
  ipca: '#3b82f6',
  selic: '#10b981',
  prefixado: '#f59e0b',
  lots: [
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#8b5cf6',
    '#ec4899',
    '#06b6d4',
    '#eab308',
    '#6366f1',
  ],
};

export function getSliceColors(slices: AllocationSlice[], mode: 'indexador' | 'lote'): string[] {
  if (slices.length === 1 && slices[0].label === 'Sem Ativos') {
    return ['#64748b'];
  }
  if (mode === 'indexador') {
    return slices.map((s) => {
      const l = s.label.toLowerCase();
      if (l.includes('selic')) return ALLOCATION_PALETTE.selic;
      if (l.includes('prefixado')) return ALLOCATION_PALETTE.prefixado;
      return ALLOCATION_PALETTE.ipca;
    });
  }
  return slices.map(
    (_, i) => ALLOCATION_PALETTE.lots[i % ALLOCATION_PALETTE.lots.length]
  );
}

export function buildAllocationConfig(
  slices: AllocationSlice[],
  mode: 'indexador' | 'lote' = 'indexador',
  theme = chartTheme()
): ChartConfiguration<'doughnut'> {
  const labels = slices.map((s) => s.label);
  const data = slices.map((s) => s.value);
  const bgColors = getSliceColors(slices, mode);

  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: bgColors,
          borderWidth: 2,
          borderColor: '#141c2e',
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: theme.textSecondary,
            font: { size: 12 },
            padding: 12,
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

@Component({
  selector: 'app-allocation-chart',
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
      height: 220px;
      min-width: 0;
    }
    canvas {
      display: block;
      width: 100% !important;
      height: 100% !important;
    }
  `],
})
export class AllocationChartComponent {
  readonly slices = input.required<AllocationSlice[]>();
  readonly mode = input<'indexador' | 'lote'>('indexador');
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');
  private readonly zone = inject(NgZone);
  chart?: Chart<'doughnut'>;

  constructor() {
    registerCharts();

    afterNextRender(() => {
      const cv = this.canvas()?.nativeElement;
      if (cv && !this.chart) {
        this.zone.runOutsideAngular(() => {
          this.chart = new Chart(
            cv,
            buildAllocationConfig(this.slices(), this.mode(), chartTheme())
          );
        });
      }
    });

    effect(() => {
      const s = this.slices();
      const m = this.mode();
      const c = this.chart;
      if (!c) return;

      c.data.labels = s.map((item) => item.label);
      if (c.data.datasets[0]) {
        c.data.datasets[0].data = s.map((item) => item.value);
        c.data.datasets[0].backgroundColor = getSliceColors(s, m);
      }
      this.zone.runOutsideAngular(() => c.update('none'));
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }
}
