/**
 * Gerenciamento de Estado - Schema e Validação
 * Sanitização de entradas, conversão pt-BR (vírgula decimal) e IDs únicos.
 */

import { DEFAULT_STATE, SimulatorState } from './defaults';
import type { CustodyTieredMode, EngineLot } from './types';

let lotIdCounter = 0;

/**
 * Gera um identificador único para novos lotes.
 */
export function generateLotId(): string {
  lotIdCounter++;
  return `lot-${Date.now().toString(36)}-${lotIdCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Converte qualquer valor (string com vírgula pt-BR, formato internacional ou número) para Number seguro.
 */
export function parseNumber<T = number>(val: any, fallback: T = 0 as unknown as T): number | T {
  if (val === null || val === undefined || val === '') return fallback;
  if (typeof val === 'number') {
    return isNaN(val) ? fallback : val;
  }
  const clean = String(val)
    .trim()
    .replace(/\s+/g, '')
    .replace(/\.(?=\d{3}(,|$|\.))/g, '') // remove separadores de milhar
    .replace(',', '.');
  const num = Number(clean);
  return isNaN(num) ? fallback : num;
}

/**
 * Valida e normaliza um lote de investimento.
 */
export function sanitizeLot(rawLot: any): EngineLot {
  if (!rawLot || typeof rawLot !== 'object') {
    throw new Error('Lote inválido: objeto esperado.');
  }

  const id = String(rawLot.id || generateLotId());
  const date = String(rawLot.date || '2026-01-01').trim();
  const rate = parseNumber(rawLot.rate, 6.55);
  const price = parseNumber(rawLot.price, 200.0);
  const qty = parseNumber(rawLot.qty, 1.0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Data do lote inválida: ${date}. Formato esperado: AAAA-MM-DD.`);
  }
  if (qty <= 0) {
    throw new Error('A quantidade de títulos deve ser maior que zero.');
  }
  if (price <= 0) {
    throw new Error('O preço do título deve ser maior que zero.');
  }

  return { id, date, rate, price, qty };
}

/**
 * Sanitiza e valida o estado da aplicação.
 */
export function sanitizeState(rawState: Partial<SimulatorState> = {}): SimulatorState {
  const state: SimulatorState = { ...DEFAULT_STATE, ...rawState };

  state.selectedBond = String(
    state.selectedBond || DEFAULT_STATE.selectedBond || 'tesouro-renda-mais-2065'
  ).trim();
  state.brapiToken = String(state.brapiToken || '').trim();
  state.refDate = String(state.refDate || DEFAULT_STATE.refDate).trim();
  state.refPrice = Math.max(0.01, parseNumber(state.refPrice, DEFAULT_STATE.refPrice));

  state.refRate =
    state.refRate === '' || state.refRate === null || state.refRate === undefined
      ? ''
      : parseNumber(state.refRate, '');

  state.spread = Math.max(0, parseNumber(state.spread, 0));
  state.ipcaCal = parseNumber(state.ipcaCal, DEFAULT_STATE.ipcaCal);
  state.selic = parseNumber(state.selic, DEFAULT_STATE.selic);
  state.ipca = parseNumber(state.ipca, DEFAULT_STATE.ipca);
  state.targetRate = parseNumber(state.targetRate, DEFAULT_STATE.targetRate);
  state.convMonths = Math.max(
    0,
    Math.round(parseNumber(state.convMonths, DEFAULT_STATE.convMonths))
  );
  state.simYears = Math.max(0, parseNumber(state.simYears, DEFAULT_STATE.simYears));

  state.simQty =
    state.simQty === '' || state.simQty === null || state.simQty === undefined
      ? ''
      : parseNumber(state.simQty, '');

  state.custMode = (
    ['single', 'marginal', 'none'].includes(state.custMode) ? state.custMode : 'single'
  ) as CustodyTieredMode;
  state.cust1 = Math.max(0, parseNumber(state.cust1, DEFAULT_STATE.cust1));
  state.cust2 = Math.max(0, parseNumber(state.cust2, DEFAULT_STATE.cust2));
  state.cust3 = Math.max(0, parseNumber(state.cust3, DEFAULT_STATE.cust3));

  state.chartMetric = ['liq', 'bruto'].includes(state.chartMetric)
    ? (state.chartMetric as 'liq' | 'bruto')
    : 'liq';
  state.chartReal = ['nom', 'real'].includes(state.chartReal)
    ? (state.chartReal as 'nom' | 'real')
    : 'nom';
  state.chartHorizonYears = Math.max(
    1,
    Math.min(40, parseNumber(state.chartHorizonYears, DEFAULT_STATE.chartHorizonYears))
  );

  // Lotes
  const rawLots =
    Array.isArray(state.lots) && state.lots.length > 0 ? state.lots : DEFAULT_STATE.lots;
  state.lots = rawLots.map(sanitizeLot);

  return state;
}
