/**
 * Motor Financeiro - Módulo de Projeção
 * Extração da lógica de curvas e benchmark de projectionChart.js
 */

import { addYearsDN } from './dates';
import { MAX_SIM_DATE, calcPU, trunc2 } from './bond';
import { getVNAFactor } from './calibration';
import { simulateSellPEPS } from './portfolio';
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

  const posLiqToday = cfg.posLiqToday ?? (lots.length > 0 ? 1000 : 0);
  const cdiAnnualRate = (Number(cdiRatePct) || 10.75) / 100;

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

  const targetRateDec = (Number(targetRatePct) || 0) / 100;

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
