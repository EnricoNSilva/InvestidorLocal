/**
 * Estado Inicial Padrão do Simulador RENDA+ 2065
 * Calibrado com os 4 lotes reais e dados oficiais do Tesouro Direto em 05/10/2026.
 */

import type { CustodyTieredMode, EngineLot } from './types';

export const DEFAULT_LOTS: EngineLot[] = [
  { id: 'lot-1', date: '2026-01-23', rate: 6.99, price: 185.02, qty: 25.35 },
  { id: 'lot-2', date: '2026-03-24', rate: 7.14, price: 177.03, qty: 56.48 },
  { id: 'lot-3', date: '2026-06-08', rate: 7.27, price: 172.89, qty: 28.92 },
  { id: 'lot-4', date: '2026-07-30', rate: 7.37, price: 168.02, qty: 29.58 },
];

export interface SimulatorState {
  // Calibração e Mercado Hoje
  selectedBond: string;
  brapiToken: string;
  refDate: string;
  refPrice: number;
  refRate: number | string; // Vazio para estimar automaticamente (~6,55% a.a.)
  spread: number; // Spread compra/venda em p.p.
  ipcaCal: number; // IPCA histórico recente da última compra até hoje (% a.a.)
  selic: number; // Taxa Selic / CDI de referência (% a.a.) para benchmark

  // Parâmetros de Projeção Futura
  ipca: number; // IPCA projetado para o futuro (% a.a.)
  targetRate: number; // Taxa real futura desejada (% a.a.)
  convMonths: number; // Tempo para convergir até a taxa alvo (meses)
  simYears: number; // Horizonte de venda (anos)
  simQty: number | string; // Quantidade a vender (vazio = vender tudo)

  // Custódia B3
  custMode: CustodyTieredMode; // 'single' | 'marginal' | 'none'
  cust1: number; // Até 10 anos (% a.a.)
  cust2: number; // De 10 a 20 anos (% a.a.)
  cust3: number; // Acima de 20 anos (% a.a.)

  // Visualização e Gráficos
  chartMetric: 'liq' | 'bruto';
  chartReal: 'nom' | 'real';
  chartHorizonYears: number; // Horizonte configurável do gráfico (anos)

  // Lotes de Aquisição
  lots: EngineLot[];
}

export const DEFAULT_STATE: SimulatorState = {
  // Calibração e Mercado Hoje
  selectedBond: 'tesouro-renda-mais-2065',
  brapiToken: '',
  refDate: '2026-10-05',
  refPrice: 243.38,
  refRate: '',
  spread: 0.0,
  ipcaCal: 4.5,
  selic: 10.75,

  // Parâmetros de Projeção Futura
  ipca: 4.5,
  targetRate: 6.55,
  convMonths: 24,
  simYears: 1.0,
  simQty: '',

  // Custódia B3
  custMode: 'single',
  cust1: 0.5,
  cust2: 0.2,
  cust3: 0.1,

  // Visualização e Gráficos
  chartMetric: 'liq',
  chartReal: 'nom',
  chartHorizonYears: 10,

  // Lotes de Aquisição
  lots: DEFAULT_LOTS,
};
