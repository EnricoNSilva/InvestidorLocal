/**
 * Motor Financeiro - Módulo de Cronograma de Anuidades (RendA+ / NTN-B1)
 * Parametriza fluxos mensais e memoização da soma descontada.
 */

import { toDayNum } from './dates';
import { getBusDays, nextBusDay } from './calendar';
import type { DayNum } from './types';

export interface AnnuitySchedule {
  readonly anoConversao: number;
  readonly numParcelas: number;
  readonly diaPagamento: number;
  readonly cashFlows: readonly DayNum[]; // dia do pagamento (ou próximo dia útil) de cada mês
  readonly firstFlow: DayNum;
  readonly lastFlow: DayNum;
  readonly flowOffsets: readonly number[]; // getBusDays(firstFlow, f)
  readonly maxSimDate: DayNum; // firstFlow - 1 (sem resgate antecipado depois disso)
  discountedFlowsSum(r: number): number; // cache Map por instância, key = Math.round(r * 1e7)
}

export function createAnnuitySchedule(
  anoConversao: number,
  numParcelas = 240,
  diaPagamento = 15
): AnnuitySchedule {
  const cashFlows: DayNum[] = [];
  for (let k = 0; k < numParcelas; k++) {
    const year = anoConversao + Math.floor(k / 12);
    const month = (k % 12) + 1;
    const rawDN = toDayNum(
      `${year}-${String(month).padStart(2, '0')}-${String(diaPagamento).padStart(2, '0')}`
    );
    cashFlows.push(nextBusDay(rawDN));
  }

  const firstFlow = cashFlows[0];
  const lastFlow = cashFlows[cashFlows.length - 1];
  const flowOffsets = cashFlows.map((f) => getBusDays(firstFlow, f));
  const maxSimDate = firstFlow - 1;

  const flowSumCache = new Map<number, number>();

  function discountedFlowsSum(r: number): number {
    const key = Math.round(r * 1e7);
    if (flowSumCache.has(key)) {
      return flowSumCache.get(key)!;
    }
    let sum = 0;
    const base = 1 + r;
    for (let i = 0; i < numParcelas; i++) {
      sum += Math.pow(base, -flowOffsets[i] / 252);
    }
    if (flowSumCache.size > 2000) {
      flowSumCache.clear();
    }
    flowSumCache.set(key, sum);
    return sum;
  }

  return {
    anoConversao,
    numParcelas,
    diaPagamento,
    cashFlows,
    firstFlow,
    lastFlow,
    flowOffsets,
    maxSimDate,
    discountedFlowsSum,
  };
}

export const RENDA_MAIS_2065: AnnuitySchedule = createAnnuitySchedule(2065, 240, 15);
