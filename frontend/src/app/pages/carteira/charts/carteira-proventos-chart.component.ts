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

export interface ItemAcaoProporcaoAnual {
  ativo_id: number;
  ticker: string;
  nome: string;
  tipo_ativo: string;
  dividendosBrl: number;
  jcpBrl: number;
  totalDivJcpBrl: number;
  totalGeralBrl: number;
  pctDividendo: number;
  pctJcp: number;
  qtdPagamentosDiv: number;
  qtdPagamentosJcp: number;
  rendimentosBrl: number;
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
            <label for="selectEmpresa" class="control-label">Empresa no Gráfico:</label>
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

      <!-- Lista Detalhada de Ações: Proporção Dividendo vs. JSCP -->
      <div class="acoes-proporcao-container" *ngIf="modoVisao() === 'ANUAL' && !semDados()">
        <div class="acoes-proporcao-header">
          <div class="acoes-header-title">
            <span class="acoes-title-text">📋 Proporção por Ação</span>
            <span class="acoes-counter">({{ listaAcoesProporcao().length }} empresas)</span>
          </div>

          <!-- Filtro de Ano da Lista de Ações -->
          <div class="anos-pill-group" *ngIf="anosDisponiveisLista().length > 0">
            <button
              type="button"
              class="btn-ano-pill"
              [class.active]="anoListaSelecionado() === 0"
              (click)="setAnoLista(0)"
              title="Ver proporção consolidada histórica"
            >
              Todos
            </button>
            <button
              *ngFor="let ano of anosDisponiveisLista()"
              type="button"
              class="btn-ano-pill"
              [class.active]="anoListaSelecionado() === ano"
              (click)="setAnoLista(ano)"
              [title]="'Filtrar pagamentos de ' + ano"
            >
              {{ ano }}
            </button>
          </div>
        </div>

        <!-- Tabela Compacta com Rolagem Suave -->
        <div class="acoes-table-wrap">
          <table class="acoes-split-table">
            <thead>
              <tr>
                <th class="th-ticker">Ação</th>
                <th class="th-barra">Div / JSCP</th>
                <th class="th-num text-green">🟢 % Div</th>
                <th class="th-num text-blue">🔵 % JSCP</th>
                <th class="th-total">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr
                *ngFor="let item of listaAcoesProporcao()"
                [class.row-selected]="ativoSelecionadoId() === item.ativo_id"
                (click)="toggleSelecaoAtivo(item.ativo_id)"
                [title]="'Clique para filtrar o gráfico superior por ' + item.ticker"
              >
                <!-- Ticker e Nome -->
                <td class="td-ticker">
                  <div class="ticker-box">
                    <span class="ticker-badge">{{ item.ticker }}</span>
                    <span class="ticker-mini-name" [title]="item.nome">{{ item.nome }}</span>
                  </div>
                </td>

                <!-- Barra Bicolor Proporcional -->
                <td class="td-barra">
                  <div class="split-bar-track" *ngIf="item.totalDivJcpBrl > 0; else rendBar">
                    <div
                      class="bar-slice slice-green"
                      [style.width.%]="item.pctDividendo"
                      [title]="'Dividendo: ' + item.pctDividendo.toFixed(1) + '% (' + formatarMoeda(item.dividendosBrl) + ')'"
                    ></div>
                    <div
                      class="bar-slice slice-blue"
                      [style.width.%]="item.pctJcp"
                      [title]="'JSCP: ' + item.pctJcp.toFixed(1) + '% (' + formatarMoeda(item.jcpBrl) + ')'"
                    ></div>
                  </div>
                  <ng-template #rendBar>
                    <div class="split-bar-track">
                      <div
                        class="bar-slice slice-purple"
                        style="width: 100%"
                        [title]="'Rendimento: 100% (' + formatarMoeda(item.rendimentosBrl) + ')'"
                      ></div>
                    </div>
                  </ng-template>
                </td>

                <!-- % Dividendo -->
                <td class="td-num">
                  <span class="val-pct text-green font-mono font-bold">{{ item.pctDividendo.toFixed(1) }}%</span>
                  <span class="val-brl font-mono text-muted" [title]="formatarMoeda(item.dividendosBrl)">
                    ({{ formatarMoedaAbrev(item.dividendosBrl) }})
                  </span>
                </td>

                <!-- % JSCP -->
                <td class="td-num">
                  <span class="val-pct text-blue font-mono font-bold">{{ item.pctJcp.toFixed(1) }}%</span>
                  <span class="val-brl font-mono text-muted" [title]="formatarMoeda(item.jcpBrl)">
                    ({{ formatarMoedaAbrev(item.jcpBrl) }})
                  </span>
                </td>

                <!-- Total R$ -->
                <td class="td-total font-mono font-bold" [title]="formatarMoeda(item.totalDivJcpBrl > 0 ? item.totalDivJcpBrl : item.totalGeralBrl)">
                  {{ formatarMoedaAbrev(item.totalDivJcpBrl > 0 ? item.totalDivJcpBrl : item.totalGeralBrl) }}
                </td>
              </tr>

              <tr *ngIf="listaAcoesProporcao().length === 0">
                <td colspan="5" class="empty-list-cell">
                  Nenhum provento registrado no período selecionado
                </td>
              </tr>
            </tbody>
          </table>
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
      height: 230px;
      min-height: 230px;
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

    /* Estilos da Lista de Ações: Proporção Dividendo vs. JSCP */
    .acoes-proporcao-container {
      margin-top: 0.85rem;
      padding-top: 0.75rem;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .acoes-proporcao-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .acoes-header-title {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    .acoes-title-text {
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--text-main);
    }
    .acoes-counter {
      font-size: 0.72rem;
      color: var(--text-muted);
    }
    .anos-pill-group {
      display: inline-flex;
      background: var(--bg-main, #0d1117);
      padding: 2px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      gap: 2px;
      overflow-x: auto;
      max-width: 100%;
    }
    .btn-ano-pill {
      background: transparent;
      border: none;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.2rem 0.45rem;
      border-radius: 4px;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
      &:hover {
        color: var(--text-main);
      }
      &.active {
        background: #3b82f6;
        color: #ffffff;
      }
    }
    .acoes-table-wrap {
      max-height: 220px;
      overflow-y: auto;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      scrollbar-width: thin;
    }
    .acoes-split-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.74rem;

      thead {
        position: sticky;
        top: 0;
        background: var(--bg-card);
        z-index: 1;
        border-bottom: 1px solid var(--border-color);
      }
      th {
        text-align: left;
        padding: 0.35rem 0.5rem;
        color: var(--text-muted);
        font-size: 0.68rem;
        font-weight: 600;
        white-space: nowrap;
      }
      th.th-num, td.td-num {
        text-align: right;
      }
      th.th-total, td.td-total {
        text-align: right;
      }
      th.th-barra {
        text-align: center;
        width: 75px;
      }
      td {
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.03);
        vertical-align: middle;
      }
      tr {
        cursor: pointer;
        transition: background 0.15s ease;
      }
      tr:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      tr.row-selected {
        background: rgba(59, 130, 246, 0.14);
        border-left: 3px solid #3b82f6;
      }
    }
    .ticker-box {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .ticker-badge {
      font-weight: 700;
      color: var(--text-main);
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.76rem;
    }
    .ticker-mini-name {
      font-size: 0.65rem;
      color: var(--text-muted);
      max-width: 90px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .split-bar-track {
      display: flex;
      width: 100%;
      min-width: 65px;
      height: 7px;
      border-radius: 3px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.08);
    }
    .bar-slice {
      height: 100%;
      transition: width 0.3s ease;
      &.slice-green { background: #10b981; }
      &.slice-blue { background: #3b82f6; }
      &.slice-purple { background: #8b5cf6; }
    }
    .val-pct {
      font-size: 0.74rem;
      display: inline-block;
      min-width: 40px;
    }
    .val-brl {
      font-size: 0.68rem;
      margin-left: 0.2rem;
      opacity: 0.85;
    }
    .empty-list-cell {
      text-align: center;
      padding: 1rem;
      color: var(--text-muted);
      font-size: 0.75rem;
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

  // Filtro de ano da lista detalhada (0 = Todos os Anos / Acumulado)
  readonly anoListaSelecionado = signal<number>(0);

  private readonly zone = inject(NgZone);
  private chart?: Chart<'bar'>;

  /**
   * Lista de anos disponíveis com pagamentos registrados (ordenados decrescente: 2026, 2025, 2024...).
   */
  readonly anosDisponiveisLista = computed<number[]>(() => {
    const lista = this.proventosAnuais();
    const anosSet = new Set<number>();
    for (const at of lista) {
      for (const a of at.anos || []) {
        if (Number(a.total_div_jcp_brl) > 0 || Number(a.total_geral_brl) > 0) {
          anosSet.add(a.ano);
        }
      }
    }
    return Array.from(anosSet).sort((a, b) => b - a);
  });

  /**
   * Consolida a lista de todas as ações e sua respectiva proporção de Dividendo vs. JSCP
   * para o ano selecionado (ou consolidado histórico quando anoListaSelecionado === 0).
   */
  readonly listaAcoesProporcao = computed<ItemAcaoProporcaoAnual[]>(() => {
    const lista = this.proventosAnuais();
    const anoSel = this.anoListaSelecionado();
    const resultado: ItemAcaoProporcaoAnual[] = [];

    for (const at of lista) {
      if (anoSel === 0) {
        // Acumulado histórico
        const div = Number(at.total_dividendos_brl) || 0;
        const jcp = Number(at.total_jcp_brl) || 0;
        const totalDivJcp = Number(at.total_div_jcp_brl) || (div + jcp);
        const rend = Number(at.total_rendimentos_brl) || 0;
        const totalGeral = Number(at.total_geral_brl) || (totalDivJcp + rend);

        if (totalGeral <= 0 && totalDivJcp <= 0) continue;

        let pctDiv = Number(at.pct_dividendo_total) || 0;
        let pctJcp = Number(at.pct_jcp_total) || 0;
        if (totalDivJcp > 0 && pctDiv === 0 && pctJcp === 0) {
          pctDiv = Number(((div / totalDivJcp) * 100).toFixed(2));
          pctJcp = Number((100 - pctDiv).toFixed(2));
        }

        const qtdDiv = (at.anos || []).reduce((acc, a) => acc + (a.qtd_pagamentos_dividendo || 0), 0);
        const qtdJcp = (at.anos || []).reduce((acc, a) => acc + (a.qtd_pagamentos_jcp || 0), 0);

        resultado.push({
          ativo_id: at.ativo_id,
          ticker: at.ticker,
          nome: at.nome,
          tipo_ativo: at.tipo_ativo,
          dividendosBrl: div,
          jcpBrl: jcp,
          totalDivJcpBrl: totalDivJcp,
          totalGeralBrl: totalGeral,
          pctDividendo: pctDiv,
          pctJcp: pctJcp,
          qtdPagamentosDiv: qtdDiv,
          qtdPagamentosJcp: qtdJcp,
          rendimentosBrl: rend,
        });
      } else {
        // Ano específico selecionado
        const anoItem = (at.anos || []).find((a) => a.ano === anoSel);
        if (!anoItem) continue;

        const div = Number(anoItem.dividendos_brl) || 0;
        const jcp = Number(anoItem.jcp_brl) || 0;
        const totalDivJcp = Number(anoItem.total_div_jcp_brl) || (div + jcp);
        const rend = Number(anoItem.rendimentos_brl) || 0;
        const totalGeral = Number(anoItem.total_geral_brl) || (totalDivJcp + rend);

        if (totalGeral <= 0 && totalDivJcp <= 0) continue;

        let pctDiv = Number(anoItem.pct_dividendo) || 0;
        let pctJcp = Number(anoItem.pct_jcp) || 0;
        if (totalDivJcp > 0 && pctDiv === 0 && pctJcp === 0) {
          pctDiv = Number(((div / totalDivJcp) * 100).toFixed(2));
          pctJcp = Number((100 - pctDiv).toFixed(2));
        }

        resultado.push({
          ativo_id: at.ativo_id,
          ticker: at.ticker,
          nome: at.nome,
          tipo_ativo: at.tipo_ativo,
          dividendosBrl: div,
          jcpBrl: jcp,
          totalDivJcpBrl: totalDivJcp,
          totalGeralBrl: totalGeral,
          pctDividendo: pctDiv,
          pctJcp: pctJcp,
          qtdPagamentosDiv: anoItem.qtd_pagamentos_dividendo || 0,
          qtdPagamentosJcp: anoItem.qtd_pagamentos_jcp || 0,
          rendimentosBrl: rend,
        });
      }
    }

    // Ordena pelo maior volume de Proventos (Div + JCP), depois total geral e ticker
    return resultado.sort(
      (a, b) =>
        b.totalDivJcpBrl - a.totalDivJcpBrl ||
        b.totalGeralBrl - a.totalGeralBrl ||
        a.ticker.localeCompare(b.ticker)
    );
  });

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
      const cv = this.canvas()?.nativeElement;
      if (cv && !this.chart) {
        this.zone.runOutsideAngular(() => {
          this.chart = new Chart(cv, this.buildConfig());
        });
      }
    });

    effect(() => {
      const modo = this.modoVisao();
      const ranking = this.data();
      const anual = this.dadosAnuais();
      const c = this.chart;

      if (modo === 'RANKING') {
        const hasValues = ranking.proventos.length > 0 && ranking.proventos.some((v: number) => v > 0);
        this.semDados.set(!hasValues);
      } else {
        const hasValues =
          anual.anosLabels.length > 0 &&
          (anual.totalDivJcpAcumulado > 0 || anual.totalRendAcumulado > 0);
        this.semDados.set(!hasValues);
      }

      if (!c) return;

      this.zone.runOutsideAngular(() => {
        c.destroy();
        const cv = this.canvas()?.nativeElement;
        if (cv) {
          this.chart = new Chart(cv, this.buildConfig());
        }
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.chart?.destroy();
      this.chart = undefined;
    });
  }

  setModoVisao(modo: 'RANKING' | 'ANUAL'): void {
    this.modoVisao.set(modo);
  }

  setAtivoSelecionado(id: string | number): void {
    this.ativoSelecionadoId.set(Number(id) || 0);
  }

  toggleSelecaoAtivo(ativoId: number): void {
    if (this.ativoSelecionadoId() === ativoId) {
      this.ativoSelecionadoId.set(0);
    } else {
      this.ativoSelecionadoId.set(ativoId);
    }
  }

  setUnidadeAnual(unidade: 'PCT' | 'BRL'): void {
    this.unidadeAnual.set(unidade);
  }

  setAnoLista(ano: number): void {
    this.anoListaSelecionado.set(ano);
  }

  formatarMoeda(valor: number): string {
    return `R$ ${valor.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  formatarMoedaAbrev(val: number): string {
    if (!val || val === 0) return 'R$ 0';
    const abs = Math.abs(val);
    if (abs >= 1000000) {
      return `R$ ${(val / 1000000).toFixed(1).replace('.', ',')}M`;
    }
    if (abs >= 1000) {
      return `R$ ${(val / 1000).toFixed(1).replace('.', ',')}k`;
    }
    return `R$ ${val.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }

  private buildConfig(): ChartConfiguration<'bar'> {
    const modo = this.modoVisao();
    const theme = chartTheme();

    if (modo === 'RANKING') {
      const ranking = this.data();
      return {
        type: 'bar',
        data: {
          labels: ranking.labels,
          datasets: [
            {
              label: 'Total Recebido (R$)',
              data: ranking.proventos,
              backgroundColor: '#10b981',
              hoverBackgroundColor: '#34d399',
              borderRadius: 4,
              yAxisID: 'y',
            },
            {
              label: 'Yield on Cost (%)',
              data: ranking.yoc,
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
                font: { size: 11, weight: 'bold' },
                boxWidth: 12,
                boxHeight: 12,
              },
            },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const val = Number(ctx.parsed.y) || 0;
                  if (ctx.datasetIndex === 0) {
                    return ` Total Recebido: ${this.formatarMoeda(val)}`;
                  }
                  return ` Yield on Cost: ${val.toFixed(2)}%`;
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
        onClick: (_event, elements) => {
          if (elements.length > 0) {
            const idx = elements[0].index;
            const anoStr = anual.anosLabels[idx];
            if (anoStr) {
              const anoNum = Number(anoStr);
              if (anoNum) {
                this.zone.run(() => {
                  this.setAnoLista(this.anoListaSelecionado() === anoNum ? 0 : anoNum);
                });
              }
            }
          }
        },
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
                linhas.push(' (Clique na coluna para filtrar a lista abaixo)');
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
