/**
 * Motor Financeiro - Módulo de Projeção
 * Extração da lógica de curvas e benchmark de projectionChart.js
 */

import { addYearsDN } from './dates';
import { MAX_SIM_DATE, calcPU, trunc2 } from './bond';
import { getVNAFactor } from './calibration';
import { simulateSell, simulateSellPEPS } from './portfolio';
import type { FixedIncomeInstrument, PricingContext } from './instruments/instrument';
import type { CustodyConfig, DayNum, EngineLot } from './types';

export interface ProjectionCurvesConfig {
  refDN: DayNum;
  Fref: number;
  lots: EngineLot[];
  custodyConfig?: CustodyConfig;
  horizonYears?: number;
  isReal?: boolean;
  metric?: 'liq' | 'bruto';
  ipca?: number;
  targetRatePct?: number;
  cdiRatePct?: number;
  posLiqToday?: number;
  maxSimDate?: DayNum;
  instrument?: FixedIncomeInstrument;
  pricingCtx?: PricingContext;
}

export interface ProjectionCurvesResult {
  points: DayNum[];
  yearSteps: number[];
  labels: string[];
  series: {
    alvo: number[];
    carrego: number[];
    cdi: number[];
    queda5: number[];
    alta8: number[];
  };
}

export function buildProjectionCurves(cfg: ProjectionCurvesConfig): ProjectionCurvesResult {
  const {
    refDN,
    Fref,
    lots,
    custodyConfig = {},
    horizonYears = 10,
    isReal = false,
    metric = 'liq',
    ipca = 4.5,
    targetRatePct = 6.55,
    cdiRatePct = 10.75,
    maxSimDate = MAX_SIM_DATE,
    instrument,
    pricingCtx,
  } = cfg;

  const clampedHorizon = Math.min(Math.max(Number(horizonYears) || 10, 3), 35);
  const points: DayNum[] = [];
  const labels: string[] = [];
  const yearSteps: number[] = [];

  for (let y = 0; y <= clampedHorizon; y += 0.5) {
    const d = Math.min(addYearsDN(refDN, y), maxSimDate);
    points.push(d);
    yearSteps.push(y);
    labels.push(y === 0 ? 'Hoje' : `${y}a`);
  }

  function getDeflator(d: DayNum): number {
    if (!isReal) return 1.0;
    return getVNAFactor(d, refDN, 1.0, ipca);
  }

  const posLiqToday = cfg.posLiqToday ?? (lots.length > 0 ? 1000 : 0);
  const cdiAnnualRate = (Number(cdiRatePct) || 10.75) / 100;
  const targetRateDec = (Number(targetRatePct) || 0) / 100;

  function getCdiValueAt(y: number, d: DayNum): number {
    const deflator = getDeflator(d);
    if (y === 0) return posLiqToday / deflator;

    const days = y * 365.25;
    const grossVal = posLiqToday * Math.pow(1 + cdiAnnualRate, y);
    if (metric === 'bruto') {
      return grossVal / deflator;
    }
    const gain = Math.max(0, grossVal - posLiqToday);
    const irRate = days <= 180 ? 0.225 : days <= 360 ? 0.2 : days <= 720 ? 0.175 : 0.15;
    const netVal = posLiqToday + gain * (1 - irRate);
    return netVal / deflator;
  }

  const isGeneric =
    instrument !== undefined &&
    instrument.kind !== 'RENDA_MAIS' &&
    instrument.kind !== 'EDUCA_MAIS';

  if (isGeneric) {
    function getGenericValueAt(d: DayNum, ctxOverrides: Partial<PricingContext>, isCarry = false): number {
      const vna = getVNAFactor(d, refDN, Fref, ipca);
      const deflator = getDeflator(d);

      const mergedCtx: PricingContext = {
        marketRate: isCarry ? 0 : targetRateDec,
        vnaFactor: vna,
        cdiAnual: cdiAnnualRate,
        selicAnual: cdiAnnualRate,
        ipcaAnual: ipca / 100,
        refDN,
        ...pricingCtx,
        ...ctxOverrides,
      };

      if (isCarry) {
        mergedCtx.marketRate = 0;
      }

      const res = simulateSell({
        lots,
        t: d,
        instrument: instrument!,
        ctx: mergedCtx,
      });

      const val = metric === 'bruto' ? res.bruto : res.liqReal;
      return val / deflator;
    }

    if (!instrument.supportsMtM) {
      // Pós-fixados bancários / Selic (sem MtM)
      const cdiBaixo = Math.max(0.02, cdiAnnualRate - 0.02);
      const cdiAlto = cdiAnnualRate + 0.02;

      const alvoSeries = points.map((d) =>
        getGenericValueAt(d, { cdiAnual: cdiAnnualRate, selicAnual: cdiAnnualRate, marketRate: 0 })
      );

      return {
        points,
        yearSteps,
        labels,
        series: {
          alvo: alvoSeries,
          carrego: [...alvoSeries],
          cdi: points.map((d, i) => getCdiValueAt(yearSteps[i], d)),
          queda5: points.map((d) =>
            getGenericValueAt(d, { cdiAnual: cdiBaixo, selicAnual: cdiBaixo, marketRate: 0 })
          ),
          alta8: points.map((d) =>
            getGenericValueAt(d, { cdiAnual: cdiAlto, selicAnual: cdiAlto, marketRate: 0 })
          ),
        },
      };
    } else {
      // Instrumentos genéricos com MtM (Tesouro Prefixado, Tesouro IPCA+ Bullet)
      return {
        points,
        yearSteps,
        labels,
        series: {
          alvo: points.map((d) => getGenericValueAt(d, { marketRate: targetRateDec })),
          carrego: points.map((d) => getGenericValueAt(d, { marketRate: 0 }, true)),
          cdi: points.map((d, i) => getCdiValueAt(yearSteps[i], d)),
          queda5: points.map((d) => getGenericValueAt(d, { marketRate: 0.05 })),
          alta8: points.map((d) => getGenericValueAt(d, { marketRate: 0.08 })),
        },
      };
    }
  }

  // Fallback 100% idêntico para RendA+ / Educa+ ou quando instrument for omitido
  function getValueAt(d: DayNum, rateAnnual: number, isCarry = false): number {
    const vna = getVNAFactor(d, refDN, Fref, ipca);
    const deflator = getDeflator(d);

    if (isCarry) {
      let tot = 0;
      for (const l of lots) {
        const lotRateDec = (Number(l.rate) || 0) / 100;
        tot += trunc2(l.qty * calcPU(d, lotRateDec, vna));
      }
      return tot / deflator;
    }

    const res = simulateSellPEPS({
      lots,
      t: d,
      r: rateAnnual,
      vnaFactor: vna,
      custodyConfig,
    });

    const val = metric === 'bruto' ? res.bruto : res.liqReal;
    return val / deflator;
  }

  return {
    points,
    yearSteps,
    labels,
    series: {
      alvo: points.map((d) => getValueAt(d, targetRateDec)),
      carrego: points.map((d) => getValueAt(d, 0, true)),
      cdi: points.map((d, i) => getCdiValueAt(yearSteps[i], d)),
      queda5: points.map((d) => getValueAt(d, 0.05)),
      alta8: points.map((d) => getValueAt(d, 0.08)),
    },
  };
}

