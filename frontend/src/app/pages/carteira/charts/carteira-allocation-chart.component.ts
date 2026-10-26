import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  NgZone,
  DestroyRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration } from 'chart.js';
import {
  ChartAlocacaoData,
  FiltroClasseCarteira,
} from '../../../core/models/investimento.models';
import { registerCharts } from '../../renda-fixa/charts/chart-registry';
import { chartTheme } from '../../renda-fixa/charts/chart-theme';

export const CLASSE_PALETTE: Record<string, string> = {
  Acao: '#3b82f6',
  FII: '#8b5cf6',
  Cripto: '#f59e0b',
  RendaFixa: '#10b981',
  Outros: '#64748b',
};

export const SEMANTIC_SETOR_PALETTE: Record<string, string> = {
  'Bancos': '#1d4ed8',
  'Seguradoras': '#059669',
  'Papel e Celulose': '#16a34a',
  'Energia Elétrica': '#eab308',
  'Saneamento': '#0284c7',
  'Mineração e Siderurgia': '#b45309',
  'Petróleo e Combustíveis': '#475569',
  'Automóveis e Peças': '#dc2626',
  'Telecomunicações': '#7c3aed',
  'Imobiliário e Shoppings': '#ea580c',
  'Imobiliário (Logística)': '#0284c7',
  'Imobiliário (Shoppings)': '#ea580c',
  'Imobiliário (Híbrido)': '#8b5cf6',
  'Imobiliário (Papel / Recebíveis)': '#0d9488',
  'Imobiliário (Lajes Corporativas)': '#4f46e5',
  'Imobiliário': '#ea580c',
  'Comércio e Varejo': '#ec4899',
  'Alimentos e Bebidas': '#84cc16',
  'Saúde e Farmácia': '#06b6d4',
  'Bens Industriais': '#6366f1',
  'Logística e Transportes': '#ca8a04',
  'Serviços Financeiros': '#3b82f6',
  'Tecnologia': '#a855f7',
  'Criptomoedas': '#f59e0b',
  'Smart Contracts': '#8b5cf6',
  'Finanças Descentralizadas (DeFi)': '#ec4899',
  'Stablecoins': '#10b981',
  'Web3 & Infraestrutura': '#06b6d4',
  'Tesouro Direto': '#10b981',
  'Títulos Bancários (CDB)': '#3b82f6',
  'Crédito Imobiliário / Agro': '#059669',
  'Renda Fixa': '#10b981',
  'Outros': '#64748b',
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
  '#84cc16',
  '#0284c7',
  '#d946ef',
  '#64748b',
];

export const ATIVO_PALETTE = [
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
  '#84cc16',
  '#0284c7',
  '#d946ef',
  '#16a34a',
  '#e11d48',
  '#2563eb',
  '#059669',
  '#d97706',
  '#7c3aed',
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
          <h3 class="chart-title">{{ titulo() }}</h3>
          <span class="chart-subtitle">{{ subtitulo() }}</span>
        </div>
        <div class="toggle-group">
          <!-- Botão 1: Por Ação / Ativo / FII / Cripto / Título -->
          <button
            type="button"
            class="toggle-btn"
            [class.active]="modo() === 'ativo'"
            (click)="setModo('ativo')"
          >
            {{ labelBotaoAtivo() }}
          </button>

          <!-- Botão 2: Por Setor / Segmento / Categoria / Indexador -->
          <button
            type="button"
            class="toggle-btn"
            [class.active]="modo() === 'setor'"
            (click)="setModo('setor')"
          >
            {{ labelBotaoSetor() }}
          </button>

          <!-- Botão 3: Por Classe (somente visível quando em Patrimônio Total ou RV Total) -->
          <button
            *ngIf="exibeBotaoClasse()"
            type="button"
            class="toggle-btn"
            [class.active]="modo() === 'classe'"
            (click)="setModo('classe')"
          >
            Por Classe
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
      gap: 2px;
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
      white-space: nowrap;
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
  readonly filtroClasse = input<FiltroClasseCarteira>('PATRIMONIO');
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');

  // Padrão: 'ativo' (ou 'setor'), oferecendo visualização rica e imediata
  readonly modo = signal<'ativo' | 'setor' | 'classe'>('ativo');

  private readonly zone = inject(NgZone);
  private chart?: Chart<'pie'>;

  readonly semDados = signal<boolean>(false);

  readonly titulo = computed(() => {
    const f = this.filtroClasse();
    switch (f) {
      case 'ACAO':
        return 'Posições em Ações';
      case 'FII':
        return 'Posições em FIIs';
      case 'CRIPTO':
        return 'Posições em Cripto';
      case 'RENDA_FIXA':
        return 'Posições em Renda Fixa';
      default:
        return 'Posições da Carteira';
    }
  });

  readonly subtitulo = computed(() => {
    const m = this.modo();
    const f = this.filtroClasse();
    if (m === 'ativo') {
      return f === 'ACAO'
        ? 'Distribuição do patrimônio por ação'
        : 'Distribuição do patrimônio por ativo';
    }
    if (m === 'setor') {
      return f === 'ACAO'
        ? 'Distribuição do patrimônio por setor de atuação'
        : 'Distribuição do patrimônio por setor / segmento';
    }
    return 'Distribuição do patrimônio por classe de ativo';
  });

  readonly labelBotaoAtivo = computed(() => {
    const f = this.filtroClasse();
    switch (f) {
      case 'ACAO':
        return 'Por Ação';
      case 'FII':
        return 'Por FII';
      case 'CRIPTO':
        return 'Por Cripto';
      case 'RENDA_FIXA':
        return 'Por Título';
      default:
        return 'Por Ativo';
    }
  });

  readonly labelBotaoSetor = computed(() => {
    const f = this.filtroClasse();
    switch (f) {
      case 'FII':
        return 'Por Segmento';
      case 'CRIPTO':
        return 'Por Categoria';
      case 'RENDA_FIXA':
        return 'Por Indexador';
      default:
        return 'Por Setor';
    }
  });

  readonly exibeBotaoClasse = computed(() => {
    const f = this.filtroClasse();
    return f === 'PATRIMONIO' || f === 'RV_TOTAL';
  });

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
      const current = this.getCurrentData(aloc, m);
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

    // Auto-ajuste de modo caso classe não esteja disponível
    effect(() => {
      const f = this.filtroClasse();
      if (this.modo() === 'classe' && f !== 'PATRIMONIO' && f !== 'RV_TOTAL') {
        this.modo.set('ativo');
      }
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }

  setModo(modo: 'ativo' | 'setor' | 'classe'): void {
    this.modo.set(modo);
  }

  private getCurrentData(aloc: ChartAlocacaoData, modo: 'ativo' | 'setor' | 'classe') {
    if (modo === 'ativo') {
      return aloc.porAtivo ?? { labels: [], data: [], percentual: [] };
    }
    if (modo === 'setor') {
      return aloc.porSetor ?? { labels: [], data: [], percentual: [] };
    }
    return aloc.porClasse ?? { labels: [], data: [], percentual: [] };
  }

  private getColors(labels: string[], modo: 'ativo' | 'setor' | 'classe'): string[] {
    if (modo === 'classe') {
      return labels.map((l) => CLASSE_PALETTE[l] || CLASSE_PALETTE['Outros']);
    }
    if (modo === 'setor') {
      return labels.map((l, i) => SEMANTIC_SETOR_PALETTE[l] || SETOR_PALETTE[i % SETOR_PALETTE.length]);
    }
    return labels.map((_, i) => ATIVO_PALETTE[i % ATIVO_PALETTE.length]);
  }

  private buildConfig(): ChartConfiguration<'pie'> {
    const aloc = this.data();
    const m = this.modo();
    const current = this.getCurrentData(aloc, m);
    const theme = chartTheme();

    return {
      type: 'pie',
      data: {
        labels: current.labels,
        datasets: [
          {
            data: current.data,
            backgroundColor: this.getColors(current.labels, m),
            borderWidth: 2,
            borderColor: '#141c2e',
            hoverOffset: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: theme.textSecondary,
              font: { size: 11 },
              padding: 8,
              boxWidth: 10,
              boxHeight: 10,
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
