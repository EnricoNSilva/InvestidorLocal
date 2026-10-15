/**
 * Motor Financeiro - Módulo de Cenários & Trajetória de Taxas
 * Modela a convergência gradual da taxa de mercado ao longo do tempo.
 */

import type { DayNum, RatePoint } from './types';

/**
 * Calcula a taxa de resgate projetada na data simDN, considerando a convergência gradual e spread.
 * @param params
 * @param params.refDN - Data inicial de calibração
 * @param params.simDN - Data simulada da venda
 * @param params.rNow - Taxa atual calibrada em decimal (ex: 0.0655)
 * @param params.targetRatePct - Taxa alvo projetada em % a.a. (ex: 6.55)
 * @param params.convMonths - Prazo de convergência em meses (0 = choque imediato)
 * @param params.spread - Spread compra/venda em p.p. (ex: 0.05)
 * @returns Taxa de venda em decimal
 */
export function calcRateAtSale({
  refDN,
  simDN,
  rNow,
  targetRatePct,
  convMonths,
  spread = 0
}: {
  refDN: DayNum;
  simDN: DayNum;
  rNow: number;
  targetRatePct: number;
  convMonths: number;
  spread?: number;
}): number {
  const targetRateDec = (Number(targetRatePct) || 0) / 100;
  const spreadDec = (Number(spread) || 0) / 100;

  const daysElapsed = Math.max(0, simDN - refDN);
  const monthsElapsed = daysElapsed / 30.4375;

  const progress = Number(convMonths) <= 0
    ? 1
    : Math.min(1, Math.max(0, monthsElapsed / Number(convMonths)));

  return rNow + (targetRateDec - rNow) * progress + spreadDec;
}

/**
 * Gera pontos de trajetória da taxa mês a mês para plotagem em gráfico.
 * @param params
 * @param params.rNow - Taxa inicial hoje em decimal
 * @param params.targetRatePct - Taxa alvo em % a.a.
 * @param params.convMonths - Meses até atingir a taxa alvo
 * @param params.spread - Spread em p.p.
 * @param params.horizonMonths - Horizonte máximo a exibir
 * @param params.stepMonths - Intervalo entre pontos
 */
export function generateRateTrajectory({
  rNow,
  targetRatePct,
  convMonths,
  spread = 0,
  horizonMonths = 36,
  stepMonths = 2
}: {
  rNow: number;
  targetRatePct: number;
  convMonths: number;
  spread?: number;
  horizonMonths?: number;
  stepMonths?: number;
}): RatePoint[] {
  const points: RatePoint[] = [];
  const targetRateDec = (Number(targetRatePct) || 0) / 100;
  const spreadDec = (Number(spread) || 0) / 100;

  for (let m = 0; m <= horizonMonths; m += stepMonths) {
    const progress = Number(convMonths) <= 0
      ? 1
      : Math.min(1, Math.max(0, m / Number(convMonths)));

    const r = rNow + (targetRateDec - rNow) * progress + spreadDec;

    points.push({
      month: m,
      label: m === 0 ? 'Hoje' : `Mês ${m}`,
      ratePct: r * 100
    });
  }

  return points;
}
