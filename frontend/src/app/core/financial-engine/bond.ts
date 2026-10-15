/**
 * Motor Financeiro - Módulo de Título (NTN-B1 RENDA+ 2065)
 * Fluxo de 240 parcelas mensais, fator de anuidade, PU e duration.
 */

import { getBusDays } from './calendar';
import { AnnuitySchedule, RENDA_MAIS_2065 } from './annuity-schedule';
import type { DayNum } from './types';

export const TRUNC_EPS = 1e-6;

/**
 * Trunca valor monetário em 2 casas decimais (padrão de liquidação do Tesouro Direto).
 */
export function trunc2(x: number | null | undefined): number {
  return Math.floor((Number(x) || 0) * 100 + TRUNC_EPS) / 100;
}

// Compatibilidade direta com constantes e referências originais do bond.js
export const CASH_FLOWS = RENDA_MAIS_2065.cashFlows;
export const FIRST_FLOW = RENDA_MAIS_2065.firstFlow;
export const LAST_FLOW = RENDA_MAIS_2065.lastFlow;
export const FLOW_OFFSETS = RENDA_MAIS_2065.flowOffsets;
export const MAX_SIM_DATE = RENDA_MAIS_2065.maxSimDate;

/**
 * Calcula o fator de anuidade na data t (em dias numéricos) com taxa anual r.
 * Representa a soma dos fatores de desconto de todos os fluxos trazidos a valor presente na data t.
 * @param t - Data em dia número UTC
 * @param r - Taxa real anual em decimal (ex: 0.0655 para 6.55%)
 * @param s - Cronograma de anuidade (padrão RENDA_MAIS_2065)
 */
export function calcAnnuityFactor(
  t: DayNum,
  r: number,
  s: AnnuitySchedule = RENDA_MAIS_2065
): number {
  const duToFirst = getBusDays(t, s.firstFlow);
  const baseDiscount = Math.pow(1 + r, -duToFirst / 252);
  const sumFlows = s.discountedFlowsSum(r);
  return baseDiscount * sumFlows;
}

/**
 * Calcula o Preço Unitário (PU) teórico a partir do fator de VNA e fator de anuidade.
 * @param t - Data de liquidação
 * @param r - Taxa anual real
 * @param vnaFactor - Fator F(t) proporcional ao VNA
 * @param s - Cronograma de anuidade (padrão RENDA_MAIS_2065)
 * @returns PU truncado em 2 casas
 */
export function calcPU(
  t: DayNum,
  r: number,
  vnaFactor: number,
  s: AnnuitySchedule = RENDA_MAIS_2065
): number {
  return trunc2(vnaFactor * calcAnnuityFactor(t, r, s));
}

/**
 * Calcula a Duration Modificada numérica do título (em anos).
 * @param t - Data
 * @param r - Taxa
 * @param eps - Diferença infinitesimal
 * @param s - Cronograma de anuidade (padrão RENDA_MAIS_2065)
 */
export function calcModifiedDuration(
  t: DayNum,
  r: number,
  eps = 1e-4,
  s: AnnuitySchedule = RENDA_MAIS_2065
): number {
  const aPlus = calcAnnuityFactor(t, r + eps, s);
  const aMinus = calcAnnuityFactor(t, r - eps, s);
  return -(Math.log(aPlus) - Math.log(aMinus)) / (2 * eps);
}
