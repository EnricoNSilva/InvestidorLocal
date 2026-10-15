/**
 * Motor Financeiro - Módulo de Calibração de Mercado e VNA
 * Estima a taxa implícita hoje (rNow) a partir do PU de resgate e calcula a evolução do VNA.
 */

import { toDayNum } from './dates';
import { getBusDays } from './calendar';
import { calcAnnuityFactor } from './bond';
import { AnnuitySchedule, RENDA_MAIS_2065 } from './annuity-schedule';
import type { Calibration, DayNum, EngineLot } from './types';

/**
 * Calibra o modelo de precificação do título.
 * @param params
 * @param params.refDate - Data de referência ('AAAA-MM-DD' ou dia numérico)
 * @param params.refPrice - Preço Unitário de Resgate hoje (ex: 243.38)
 * @param params.refRate - Taxa de resgate informada manualmente (% a.a.) ou vazia para auto-inferir
 * @param params.lots - Lista de lotes comprados [{ date, rate, price, qty }]
 * @param params.ipcaCal - IPCA anual estimado entre a última compra e a data de referência (% a.a.)
 * @param params.schedule - Cronograma de anuidade (padrão RENDA_MAIS_2065)
 */
export function calibrateModel({
  refDate,
  refPrice,
  refRate = '',
  lots = [],
  ipcaCal = 4.5,
  schedule = RENDA_MAIS_2065,
}: {
  refDate: string | DayNum;
  refPrice: number;
  refRate?: number | string | null;
  lots?: EngineLot[];
  ipcaCal?: number;
  schedule?: AnnuitySchedule;
}): Calibration {
  const refDN = typeof refDate === 'number' ? refDate : toDayNum(refDate);
  const pNow = Number(refPrice) || 243.38;
  let rNow: number;

  if (refRate !== '' && refRate !== null && !isNaN(Number(refRate))) {
    rNow = Number(refRate) / 100;
  } else if (lots && lots.length > 0) {
    const anchor = lots[lots.length - 1];
    const anchorDN = typeof anchor.dn === 'number' ? anchor.dn : toDayNum(anchor.date);
    const anchorRate = (Number(anchor.rate) || 0) / 100;
    const anchorPrice = Number(anchor.price) || 0;
    const calIpcaDec = (Number(ipcaCal) || 4.5) / 100;
    const busDaysFromAnchor = getBusDays(anchorDN, refDN);

    const anchorF =
      (anchorPrice / calcAnnuityFactor(anchorDN, anchorRate, schedule)) *
      Math.pow(1 + calIpcaDec, busDaysFromAnchor / 252);

    let lo = -0.05;
    let hi = 0.35;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (anchorF * calcAnnuityFactor(refDN, mid, schedule) > pNow) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    rNow = (lo + hi) / 2;
  } else {
    rNow = 0.0655;
  }

  const Fref = pNow / calcAnnuityFactor(refDN, rNow, schedule);

  return {
    refDN,
    rNow,
    Fref,
    pNow,
  };
}

/**
 * Retorna o fator de VNA na data t a partir da data de referência e IPCA anual projetado.
 * @param t - Data alvo em dia numérico
 * @param refDN - Data de referência calibrada
 * @param Fref - Fator de escala base F(refDN)
 * @param projectedIpcaPct - IPCA anual projetado (% a.a.)
 */
export function getVNAFactor(
  t: DayNum,
  refDN: DayNum,
  Fref: number,
  projectedIpcaPct = 4.5
): number {
  const ipca = (Number(projectedIpcaPct) || 0) / 100;
  if (t >= refDN) {
    const du = getBusDays(refDN, t);
    return Fref * Math.pow(1 + ipca, du / 252);
  } else {
    const du = getBusDays(t, refDN);
    return Fref / Math.pow(1 + ipca, du / 252);
  }
}
