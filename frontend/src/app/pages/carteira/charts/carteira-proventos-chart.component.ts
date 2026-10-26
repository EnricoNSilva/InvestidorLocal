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
  computed,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Chart, ChartConfiguration } from 'chart.js';
import {
  ChartRankingProventosData,
  ProventoAnoItem,
  ProventosAtivoAnual,
} from '../../../core/models/investimento.models';
import { registerCharts } from '../../renda-fixa/charts/chart-registry';
import { chartTheme } from '../../renda-fixa/charts/chart-theme';

export interface ResumoAnualConsolidado {
  anosLabels: string[];
  dividendosValores: number[];
  jcpValores: number[];
  dividendosPct: number[];
  jcpPct: number[];
  rendimentosValores: number[];
  totalDivJcpValores: number[];
  totalGeralValores: number[];
  totalDivAcumulado: number;
  totalJcpAcumulado: number;
  totalRendAcumulado: number;
  totalDivJcpAcumulado: number;
  pctDivAcumulado: number;
  pctJcpAcumulado: number;
}

@Component({
  selector: 'app-carteira-proventos-chart',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card">
      <div class="chart-header">
        <div class="header-titles">
          <div class="title-row">
            <h3 class="chart-title">
              {{ modoVisao() === 'RANKING' ? titulo() : 'Proporção Anual: Dividendo vs. JSCP' }}
            </h3>
            <div class="mode-toggles">
              <button
                type="button"
                class="btn-mode"
                [class.active]="modoVisao() === 'RANKING'"
                (click)="setModoVisao('RANKING')"
                title="Top 10 geradores de proventos e YoC"
              >
                🏆 Ranking & YoC
              </button>
              <button
                type="button"
                class="btn-mode"
                [class.active]="modoVisao() === 'ANUAL'"
                (click)="setModoVisao('ANUAL')"
                title="Análise ano a ano de Dividendos vs. JSCP"
              >
                📅 Div. vs JCP (Ano)
              </button>
            </div>
          </div>
          <span class="chart-subtitle">
            {{ modoVisao() === 'RANKING' ? subtitulo() : 'Composição percentual (%) e valores (R$) recebidos ano a ano' }}
          </span>
        </div>

        <!-- Controles exclusivos do modo ANUAL -->
        <div class="anual-controls" *ngIf="modoVisao() === 'ANUAL'">
          <div class="select-container">
            <label for="selectEmpresa" class="control-label">Empresa em Custódia:</label>
            <select
              id="selectEmpresa"
              class="select-control"
              [ngModel]="ativoSelecionadoId()"
              (ngModelChange)="setAtivoSelecionado($event)"
            >
              <option [value]="0">📊 Todas em Custódia (Consolidado)</option>
              <option *ngFor="let at of proventosAnuais()" [value]="at.ativo_id">
                {{ at.ticker }} - {{ at.nome }}
              </option>
            </select>
          </div>

          <div class="unit-toggles">
            <label class="control-label">Escala:</label>
            <div class="pill-group">
              <button
                type="button"
                class="btn-unit"
                [class.active]="unidadeAnual() === 'PCT'"
                (click)="setUnidadeAnual('PCT')"
                title="Exibir em 100% empilhado (%)"
              >
                % (100%)
              </button>
              <button
                type="button"
                class="btn-unit"
                [class.active]="unidadeAnual() === 'BRL'"
                (click)="setUnidadeAnual('BRL')"
                title="Exibir valores absolutos em R$"
              >
                R$
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="canvas-container">
        <canvas #cv></canvas>
        <div *ngIf="semDados()" class="empty-overlay">
          <span>
            {{ modoVisao() === 'RANKING'
                ? 'Nenhum provento registrado no filtro selecionado'
                : 'Nenhum provento registrado para a empresa selecionada' }}
          </span>
        </div>
      </div>

      <!-- Barra de Resumo Histórico no modo ANUAL -->
      <div class="summary-strip" *ngIf="modoVisao() === 'ANUAL' && !semDados()">
        <div class="strip-item">
          <span class="strip-label">Total Div + JCP:</span>
          <span class="strip-val font-mono font-bold">{{ formatarMoeda(dadosAnuais().totalDivJcpAcumulado) }}</span>
        </div>
        <div class="strip-item">
          <span class="badge-dot dot-green"></span>
          <span class="strip-label">Dividendo:</span>
          <span class="strip-val font-mono text-green font-bold">
            {{ dadosAnuais().pctDivAcumulado.toFixed(1) }}%
            <span class="strip-sub">({{ formatarMoeda(dadosAnuais().totalDivAcumulado) }})</span>
          </span>
        </div>
        <div class="strip-item">
          <span class="badge-dot dot-blue"></span>
          <span class="strip-label">JSCP:</span>
          <span class="strip-val font-mono text-blue font-bold">
            {{ dadosAnuais().pctJcpAcumulado.toFixed(1) }}%
            <span class="strip-sub">({{ formatarMoeda(dadosAnuais().totalJcpAcumulado) }})</span>
          </span>
        </div>
        <div class="strip-item" *ngIf="dadosAnuais().totalRendAcumulado > 0">
          <span class="strip-label">Aluguel BTC / Rend.:</span>
          <span class="strip-val font-mono text-muted">
            {{ formatarMoeda(dadosAnuais().totalRendAcumulado) }}
          </span>
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
      margin-bottom: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }
    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
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
    .mode-toggles {
      display: inline-flex;
      background: var(--bg-main, #0d1117);
      padding: 2px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }
    .btn-mode {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.3rem 0.6rem;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
      &:hover {
        color: var(--text-main);
      }
      &.active {
        background: var(--bg-card-hover, rgba(255, 255, 255, 0.08));
        color: var(--primary, #238636);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }
    }
    .anual-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
      padding-top: 0.4rem;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .select-container {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex: 1;
      min-width: 220px;
    }
    .control-label {
      font-size: 0.74rem;
      color: var(--text-muted);
      font-weight: 600;
      white-space: nowrap;
    }
    .select-control {
      background: var(--bg-main, #0d1117);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 6px;
      padding: 0.3rem 0.6rem;
      font-size: 0.78rem;
      outline: none;
      width: 100%;
      max-width: 280px;
      cursor: pointer;
      &:focus {
        border-color: var(--primary, #238636);
      }
    }
    .unit-toggles {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .pill-group {
      display: inline-flex;
      background: var(--bg-main, #0d1117);
      padding: 2px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }
    .btn-unit {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 0.72rem;
      font-weight: 700;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
      &:hover {
        color: var(--text-main);
      }
      &.active {
        background: #3b82f6;
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
    .summary-strip {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      flex-wrap: wrap;
      gap: 1rem;
      margin-top: 0.75rem;
      padding-top: 0.65rem;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 0.76rem;
    }
    .strip-item {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .strip-label {
      color: var(--text-muted);
    }
    .strip-val {
      color: var(--text-main);
    }
    .strip-sub {
      font-size: 0.72rem;
      opacity: 0.85;
      font-weight: normal;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      &.dot-green { background: #10b981; }
      &.dot-blue { background: #3b82f6; }
    }
    .text-green { color: #10b981; }
    .text-blue { color: #3b82f6; }
    .text-muted { color: var(--text-muted); }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .font-bold {
      font-weight: 700;
    }
  `],
})
export class CarteiraProventosChartComponent {
  readonly data = input.required<ChartRankingProventosData>();
  readonly proventosAnuais = input<ProventosAtivoAnual[]>([]);
  readonly titulo = input<string>('Top Geradores de Proventos & YoC');
  readonly subtitulo = input<string>('Total acumulado recebido (R$) vs. Yield on Cost (%)');
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('cv');

  readonly modoVisao = signal<'RANKING' | 'ANUAL'>('RANKING');
  readonly ativoSelecionadoId = signal<number>(0);
  readonly unidadeAnual = signal<'PCT' | 'BRL'>('PCT');
  readonly semDados = signal<boolean>(false);

  private readonly zone = inject(NgZone);
  private chart?: Chart<'bar'>;

  /**
   * Consolida dados anuais da empresa selecionada (ou de todas em custódia).
   */
  readonly dadosAnuais = computed<ResumoAnualConsolidado>(() => {
    const lista = this.proventosAnuais();
    const selId = Number(this.ativoSelecionadoId()) || 0;

    let ativosFiltrados: ProventosAtivoAnual[];
    if (selId === 0 || !lista.some((a) => a.ativo_id === selId)) {
      ativosFiltrados = lista;
    } else {
      ativosFiltrados = lista.filter((a) => a.ativo_id === selId);
    }

    // Mapa ano -> { div: 0, jcp: 0, rend: 0 }
    const mapaAno: Record<number, { div: number; jcp: number; rend: number }> = {};
    for (const at of ativosFiltrados) {
      for (const anoItem of at.anos || []) {
        const ano = anoItem.ano;
        if (!mapaAno[ano]) {
          mapaAno[ano] = { div: 0, jcp: 0, rend: 0 };
        }
        mapaAno[ano].div += Number(anoItem.dividendos_brl) || 0;
        mapaAno[ano].jcp += Number(anoItem.jcp_brl) || 0;
        mapaAno[ano].rend += Number(anoItem.rendimentos_brl) || 0;
      }
    }

    const anosOrdenados = Object.keys(mapaAno)
      .map(Number)
      .sort((a, b) => a - b);

    const anosLabels: string[] = [];
    const dividendosValores: number[] = [];
    const jcpValores: number[] = [];
    const dividendosPct: number[] = [];
    const jcpPct: number[] = [];
    const rendimentosValores: number[] = [];
    const totalDivJcpValores: number[] = [];
    const totalGeralValores: number[] = [];

    let totalDivAcumulado = 0;
    let totalJcpAcumulado = 0;
    let totalRendAcumulado = 0;

    for (const ano of anosOrdenados) {
      const item = mapaAno[ano];
      const d = item.div;
      const j = item.jcp;
      const r = item.rend;
      const totalDivJcp = d + j;
      const totalGeral = totalDivJcp + r;

      anosLabels.push(String(ano));
      dividendosValores.push(d);
      jcpValores.push(j);
      rendimentosValores.push(r);
      totalDivJcpValores.push(totalDivJcp);
      totalGeralValores.push(totalGeral);

      if (totalDivJcp > 0) {
        const pDiv = Number(((d / totalDivJcp) * 100).toFixed(2));
        const pJcp = Number((100 - pDiv).toFixed(2));
        dividendosPct.push(pDiv);
        jcpPct.push(pJcp);
      } else {
        dividendosPct.push(0);
        jcpPct.push(0);
      }

      totalDivAcumulado += d;
      totalJcpAcumulado += j;
      totalRendAcumulado += r;
    }

    const totalDivJcpAcumulado = totalDivAcumulado + totalJcpAcumulado;
    let pctDivAcumulado = 0;
    let pctJcpAcumulado = 0;
    if (totalDivJcpAcumulado > 0) {
      pctDivAcumulado = Number(((totalDivAcumulado / totalDivJcpAcumulado) * 100).toFixed(2));
      pctJcpAcumulado = Number((100 - pctDivAcumulado).toFixed(2));
    }

    return {
      anosLabels,
      dividendosValores,
      jcpValores,
      dividendosPct,
      jcpPct,
      rendimentosValores,
      totalDivJcpValores,
      totalGeralValores,
      totalDivAcumulado,
      totalJcpAcumulado,
      totalRendAcumulado,
      totalDivJcpAcumulado,
      pctDivAcumulado,
      pctJcpAcumulado,
    };
  });

  constructor() {
    registerCharts();

    afterNextRender(() => {
      this.reconstruirGrafico();
    });

    effect(() => {
      // Reativo às mudanças de modo, ativo selecionado, unidade e dados
      const lista = this.proventosAnuais();
      const selId = Number(this.ativoSelecionadoId()) || 0;
      if (selId !== 0 && lista.length > 0 && !lista.some((a) => a.ativo_id === selId)) {
        this.ativoSelecionadoId.set(0);
      }

      const modo = this.modoVisao();
      const ranking = this.data();
      const anual = this.dadosAnuais();
      const unidade = this.unidadeAnual();

      if (modo === 'RANKING') {
        const hasValues = ranking.proventos.length > 0 && ranking.proventos.some((v) => v > 0);
        this.semDados.set(!hasValues);
      } else {
        const hasValues = anual.anosLabels.length > 0 && anual.totalGeralValores.some((v) => v > 0);
        this.semDados.set(!hasValues);
      }

      this.reconstruirGrafico();
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }

  setModoVisao(modo: 'RANKING' | 'ANUAL'): void {
    this.modoVisao.set(modo);
  }

  setAtivoSelecionado(ativoId: number | string): void {
    this.ativoSelecionadoId.set(Number(ativoId) || 0);
  }

  setUnidadeAnual(unidade: 'PCT' | 'BRL'): void {
    this.unidadeAnual.set(unidade);
  }

  formatarMoeda(val: number): string {
    return `R$ ${val.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private reconstruirGrafico(): void {
    const cv = this.canvas()?.nativeElement;
    if (!cv) return;

    if (this.chart) {
      this.chart.destroy();
      this.chart = undefined;
    }

    this.zone.runOutsideAngular(() => {
      this.chart = new Chart(cv, this.buildConfig());
    });
  }

  private buildConfig(): ChartConfiguration<'bar'> {
    const theme = chartTheme();
    const modo = this.modoVisao();

    if (modo === 'RANKING') {
      const d = this.data();
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
                    return ` Proventos: ${this.formatarMoeda(val)}`;
                  } else {
                    return ` YoC: ${val.toFixed(2)}%`;
                  }
                },
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: theme.textSecondary, font: { size: 10, weight: 'bold' } },
            },
            y: {
              type: 'linear',
              position: 'left',
              grid: { color: theme.borderGrid },
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
              grid: { drawOnChartArea: false },
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

    // Modo ANUAL (Barras empilhadas Dividendo vs JSCP, ou 100% Rendimento para FIIs)
    const anual = this.dadosAnuais();
    const isPct = this.unidadeAnual() === 'PCT';
    const somenteRendimento = anual.totalDivJcpAcumulado === 0 && anual.totalRendAcumulado > 0;

    const divData = isPct ? anual.dividendosPct : anual.dividendosValores;
    const jcpData = isPct ? anual.jcpPct : anual.jcpValores;
    const rendData = isPct
      ? anual.rendimentosValores.map((v) => (v > 0 ? 100 : 0))
      : anual.rendimentosValores;

    const datasets = somenteRendimento
      ? [
          {
            label: isPct ? 'Rendimento FII / Earn (%)' : 'Rendimento FII / Earn (R$)',
            data: rendData,
            backgroundColor: '#8b5cf6',
            hoverBackgroundColor: '#a78bfa',
            borderRadius: isPct ? 0 : 4,
            stack: 'proventos',
          },
        ]
      : [
          {
            label: isPct ? 'Dividendo (%)' : 'Dividendo (R$)',
            data: divData,
            backgroundColor: '#10b981',
            hoverBackgroundColor: '#34d399',
            borderRadius: isPct ? 0 : 4,
            stack: 'proventos',
          },
          {
            label: isPct ? 'JSCP (%)' : 'JSCP (R$)',
            data: jcpData,
            backgroundColor: '#3b82f6',
            hoverBackgroundColor: '#60a5fa',
            borderRadius: isPct ? 0 : 4,
            stack: 'proventos',
          },
        ];

    return {
      type: 'bar',
      data: {
        labels: anual.anosLabels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: theme.textSecondary,
              font: { size: 11, weight: 'bold' },
              boxWidth: 12,
              boxHeight: 12,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const idx = ctx.dataIndex;
                if (somenteRendimento) {
                  const rVal = anual.rendimentosValores[idx] || 0;
                  return ` 🟣 Rendimento: ${this.formatarMoeda(rVal)} (100.0%)`;
                }
                const dVal = anual.dividendosValores[idx] || 0;
                const jVal = anual.jcpValores[idx] || 0;
                const dPct = anual.dividendosPct[idx] || 0;
                const jPct = anual.jcpPct[idx] || 0;
                if (ctx.datasetIndex === 0) {
                  return ` 🟢 Dividendo: ${this.formatarMoeda(dVal)} (${dPct.toFixed(1)}%)`;
                } else {
                  return ` 🔵 JSCP: ${this.formatarMoeda(jVal)} (${jPct.toFixed(1)}%)`;
                }
              },
              afterBody: (items) => {
                if (!items.length || somenteRendimento) return [];
                const idx = items[0].dataIndex;
                const totalDivJcp = anual.totalDivJcpValores[idx] || 0;
                const rend = anual.rendimentosValores[idx] || 0;
                const linhas: string[] = [` Total Div+JCP: ${this.formatarMoeda(totalDivJcp)}`];
                if (rend > 0) {
                  linhas.push(` ℹ️ Aluguel BTC / Rend.: ${this.formatarMoeda(rend)}`);
                }
                return linhas;
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            ticks: { color: theme.textSecondary, font: { size: 11, weight: 'bold' } },
          },
          y: {
            stacked: true,
            max: isPct ? 100 : undefined,
            grid: { color: theme.borderGrid },
            ticks: {
              color: theme.textSecondary,
              font: { size: 10 },
              callback: (val) => {
                if (isPct) return `${val}%`;
                const num = Number(val);
                if (num >= 1000) return `R$ ${(num / 1000).toFixed(1)}k`;
                return `R$ ${num}`;
              },
            },
          },
        },
      },
    };
  }
}
