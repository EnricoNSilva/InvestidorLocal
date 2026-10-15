/**
 * Motor Financeiro - Módulo de Métricas de Rentabilidade & Análise de Risco
 * TIR (XIRR), retorno real, taxa de empate, sensibilidade e duration.
 */

import { trunc2, calcPU } from './bond';
import { simulateSellPEPS } from './portfolio';
import type { CustodyConfig, DayNum, EngineLot, SensitivityRow } from './types';

/**
 * Rentabilidade percentual simples.
 */
export function calcReturnPct(value: number, cost: number): number {
  if (!cost || cost <= 0) return 0;
  return (value - cost) / cost;
}

/**
 * Retorno real expurgando a inflação (equação de Fisher).
 * @param nominalReturn - Retorno nominal em decimal (ex: 0.3037)
 * @param inflation - Inflação acumulada em decimal (ex: 0.045)
 * @returns Retorno real em decimal
 */
export function calcRealReturn(nominalReturn: number, inflation: number): number {
  if (inflation <= -1) return nominalReturn;
  return (1 + nominalReturn) / (1 + inflation) - 1;
}

/**
 * Alias de Fisher para consistência com o plano de unificação.
 */
export const fisherReal = calcRealReturn;

/**
 * Calcula a Taxa Interna de Retorno anualizada (TIR / XIRR) para fluxos irregulares.
 * @param cashFlows - Fluxos de caixa (compras negativas, resgate positivo)
 * @param guess - Palpite inicial
 * @returns TIR anualizada em decimal (ex: 0.12 para 12% a.a.)
 */
export function calcXIRR(
  cashFlows: { dn: DayNum; amount?: number; value?: number }[],
  guess = 0.1
): number {
  if (!cashFlows || cashFlows.length < 2) return 0;

  const validFlows = cashFlows
    .map((f) => ({
      dn: f.dn,
      amount: f.amount ?? f.value ?? 0,
    }))
    .filter((f) => f.amount !== 0 && !isNaN(f.amount));

  const hasPositive = validFlows.some((f) => f.amount > 0);
  const hasNegative = validFlows.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) return 0;

  const t0 = validFlows[0].dn;

  function npvAndDeriv(r: number): { npv: number; dNpv: number } {
    let npv = 0;
    let dNpv = 0;
    for (const f of validFlows) {
      const dt = (f.dn - t0) / 365.25;
      const factor = Math.pow(1 + r, dt);
      npv += f.amount / factor;
      if (dt !== 0) {
        dNpv -= (dt * f.amount) / (factor * (1 + r));
      }
    }
    return { npv, dNpv };
  }

  // Método de Newton-Raphson com restrição de intervalo
  let r = guess;
  for (let i = 0; i < 50; i++) {
    if (r <= -0.999) r = -0.99;
    const { npv, dNpv } = npvAndDeriv(r);
    if (Math.abs(npv) < 1e-5) return r;
    if (Math.abs(dNpv) < 1e-9) break;
    const nextR = r - npv / dNpv;
    if (Math.abs(nextR - r) < 1e-6) return nextR;
    r = nextR;
  }

  // Fallback: Busca binária (bisseção) caso Newton não convirja
  let lo = -0.99;
  let hi = 5.0;
  let npvLo = npvAndDeriv(lo).npv;

  for (let j = 0; j < 60; j++) {
    const mid = (lo + hi) / 2;
    const { npv: npvMid } = npvAndDeriv(mid);
    if (Math.abs(npvMid) < 1e-5) return mid;
    if ((npvLo > 0 && npvMid > 0) || (npvLo < 0 && npvMid < 0)) {
      lo = mid;
      npvLo = npvMid;
    } else {
      hi = mid;
    }
  }

  return (lo + hi) / 2;
}

/**
 * Calcula a Taxa de Empate (breakeven rate) para uma data futura:
 * taxa em que o saldo líquido final empata exatamente com o capital total investido.
 */
export function calcBreakevenRate({
  lots,
  simDN,
  vnaFactor,
  custodyConfig = {},
}: {
  lots: EngineLot[];
  simDN: DayNum;
  vnaFactor: number;
  custodyConfig?: CustodyConfig;
}): number | null {
  const totalCost = lots.reduce((acc, l) => acc + trunc2(l.qty * l.price), 0);
  if (totalCost <= 0) return null;

  let lo = -0.05;
  let hi = 0.35;

  const resLo = simulateSellPEPS({ lots, t: simDN, r: lo, vnaFactor, custodyConfig });
  const resHi = simulateSellPEPS({ lots, t: simDN, r: hi, vnaFactor, custodyConfig });

  if (resLo.liqReal < totalCost) return null; // Já dá prejuízo mesmo na menor taxa
  if (resHi.liqReal > totalCost) return hi; // Dá lucro mesmo com taxa de 35%

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const resMid = simulateSellPEPS({ lots, t: simDN, r: mid, vnaFactor, custodyConfig });
    const diff = resMid.liqReal - totalCost;

    if (Math.abs(diff) < 0.5) return mid;
    if (diff > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return (lo + hi) / 2;
}

/**
 * Gera a tabela de sensibilidade a choques instantâneos de taxa de juros na data de referência.
 */
export function calcSensitivityTable({
  refDN,
  rNow,
  pNow,
  vnaFactor,
  lots,
  shocks = [-1.0, -0.5, -0.25, -0.1, 0.1, 0.25, 0.5, 1.0],
  custodyConfig = {},
}: {
  refDN: DayNum;
  rNow: number;
  pNow: number;
  vnaFactor: number;
  lots: EngineLot[];
  shocks?: number[];
  custodyConfig?: CustodyConfig;
}): SensitivityRow[] {
  const baseRes = simulateSellPEPS({
    lots,
    t: refDN,
    r: rNow,
    vnaFactor,
    custodyConfig,
    overridePU: pNow,
  });

  return shocks.map((s) => {
    const shockDec = s / 100;
    const newRate = rNow + shockDec;
    const newPU = calcPU(refDN, newRate, vnaFactor);
    const shockRes = simulateSellPEPS({
      lots,
      t: refDN,
      r: newRate,
      vnaFactor,
      custodyConfig,
      overridePU: newPU,
    });

    const brutoDiff = shockRes.bruto - baseRes.bruto;
    const liqDiff = shockRes.liqApp - baseRes.liqApp;
    const puVarPct = (newPU - pNow) / pNow;
    const liqReturnPct = calcReturnPct(shockRes.liqApp, shockRes.custo);

    return {
      shock: s,
      newRate,
      newPU,
      bruto: shockRes.bruto,
      brutoDiff,
      liqApp: shockRes.liqApp,
      liqDiff,
      puVarPct,
      liqReturnPct,
    };
  });
}
