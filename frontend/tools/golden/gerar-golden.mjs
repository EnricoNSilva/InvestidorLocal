/**
 * Script de Geração de Fixtures Golden Master
 * Executa o motor original em JavaScript puro e salva as saídas em JSON
 * para validação de regressão 1:1 no TypeScript.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Importa motor original
import * as originalEngine from '../../../reference-engine/src/core/index.js';
import { DEFAULT_LOTS, DEFAULT_STATE } from '../../../reference-engine/src/state/defaults.js';

const {
  toDayNum,
  dayNumToIso,
  formatBRLDate,
  addMonthsDN,
  addYearsDN,
  diffDays,
  diffYears,
  getEaster,
  isBusDay,
  getBusDays,
  nextBusDay,
  calcAnnuityFactor,
  calcPU,
  calcModifiedDuration,
  trunc2,
  calibrateModel,
  getVNAFactor,
  calcRateAtSale,
  generateRateTrajectory,
  getIRRate,
  getIRSchedule,
  calcIOF,
  calcCustodyFee,
  simulateSellPEPS,
  decomposeCarryAndMtM,
  calcReturnPct,
  calcRealReturn,
  calcXIRR,
  calcBreakevenRate,
  calcSensitivityTable,
  MAX_SIM_DATE
} = originalEngine;

console.log('Iniciando geração do Golden Master...');

// 1. Calendário e Datas (~500 pares de datas entre 2000 e 2090)
const sampleDates = [
  '2000-01-01', '2004-02-29', '2010-04-21', '2020-12-25',
  '2023-11-20', '2024-11-20', '2026-01-23', '2026-03-24',
  '2026-04-03', '2026-04-05', '2026-06-04', '2026-10-05',
  '2026-10-10', '2026-10-12', '2026-10-13', '2026-11-20',
  '2030-01-15', '2040-07-07', '2065-01-15', '2084-12-15',
  '2090-12-31'
];

const easterYears = [2000, 2010, 2020, 2024, 2025, 2026, 2027, 2030, 2040, 2050, 2065, 2084, 2090];
const easterTests = easterYears.map(y => ({
  year: y,
  easterDN: getEaster(y),
  easterIso: dayNumToIso(getEaster(y))
}));

const busDayTests = sampleDates.map(d => {
  const dn = toDayNum(d);
  return {
    iso: d,
    dn,
    isBus: isBusDay(dn),
    nextBus: nextBusDay(dn),
    nextBusIso: dayNumToIso(nextBusDay(dn)),
    formatBRL: formatBRLDate(dn)
  };
});

const getBusDaysPairs = [];
for (let i = 0; i < sampleDates.length; i++) {
  for (let j = 0; j < sampleDates.length; j += 2) {
    const da = sampleDates[i];
    const db = sampleDates[j];
    const dna = toDayNum(da);
    const dnb = toDayNum(db);
    getBusDaysPairs.push({
      da,
      db,
      dna,
      dnb,
      busDays: getBusDays(dna, dnb),
      diffD: diffDays(dna, dnb),
      diffY: diffYears(dna, dnb)
    });
  }
}

// 2. Título NTN-B1 / Bond: grade t x r
const gridT = [
  toDayNum('2026-10-05'),
  addYearsDN(toDayNum('2026-10-05'), 1),
  addYearsDN(toDayNum('2026-10-05'), 5),
  addYearsDN(toDayNum('2026-10-05'), 10),
  MAX_SIM_DATE
];

const bondGrid = [];
for (const t of gridT) {
  for (let rBps = 400; rBps <= 900; rBps += 25) {
    const r = rBps / 10000; // 0.04 a 0.09 com passo 0.0025
    const vnaFactor = 1.05;
    bondGrid.push({
      t,
      r,
      annuityFactor: calcAnnuityFactor(t, r),
      pu: calcPU(t, r, vnaFactor),
      modDuration: calcModifiedDuration(t, r)
    });
  }
}

// 3. Calibração e VNA
const calibWithRate = calibrateModel({
  refDate: '2026-10-05',
  refPrice: 243.38,
  refRate: 6.55,
  lots: DEFAULT_LOTS,
  ipcaCal: 4.5
});

const calibInferRate = calibrateModel({
  refDate: '2026-10-05',
  refPrice: 243.38,
  refRate: '',
  lots: DEFAULT_LOTS,
  ipcaCal: 4.5
});

const vnaPoints = [];
const refDN = calibInferRate.refDN;
const fRef = calibInferRate.Fref;
for (let deltaY = -2; deltaY <= 10; deltaY += 0.5) {
  const t = addYearsDN(refDN, deltaY);
  vnaPoints.push({
    t,
    refDN,
    fRef,
    vna4_5: getVNAFactor(t, refDN, fRef, 4.5),
    vna6_0: getVNAFactor(t, refDN, fRef, 6.0)
  });
}

// 4. Cenários e Trajetória
const scenarios = [];
for (const convMonths of [0, 6, 12, 24]) {
  for (const spread of [0, 0.05, 0.10]) {
    for (const targetRatePct of [5.0, 6.55, 8.0]) {
      const traj = generateRateTrajectory({
        rNow: calibInferRate.rNow,
        targetRatePct,
        convMonths,
        spread,
        horizonMonths: 24,
        stepMonths: 6
      });
      const simDN = addYearsDN(refDN, 1);
      const rAtSale = calcRateAtSale({
        refDN,
        simDN,
        rNow: calibInferRate.rNow,
        targetRatePct,
        convMonths,
        spread
      });
      scenarios.push({
        convMonths,
        spread,
        targetRatePct,
        rAtSale,
        traj
      });
    }
  }
}

// 5. Impostos e Custódia
const taxDays = [
  0, 1, 15, 29, 30, 31, 45, 100, 180, 181, 250, 360, 361, 500, 720, 721, 1000, 3652, 3653, 4380, 7305, 7306, 8000
];
const taxTests = taxDays.map(days => ({
  days,
  irRate: getIRRate(days),
  irSchedule: getIRSchedule(days),
  iofPos: calcIOF(1000, days),
  iofZero: calcIOF(0, days),
  iofNeg: calcIOF(-500, days),
  custSingle: calcCustodyFee(34153.50, days, { custMode: 'single', cust1: 0.50, cust2: 0.20, cust3: 0.10 }),
  custMarginal: calcCustodyFee(34153.50, days, { custMode: 'marginal', cust1: 0.50, cust2: 0.20, cust3: 0.10 }),
  custNone: calcCustodyFee(34153.50, days, { custMode: 'none' })
}));

// 6. Portfólio / PEPS (venda total, parcial, hoje, futuro)
const vnaHoje = getVNAFactor(refDN, refDN, fRef, 4.5);
const sellHojeTotal = simulateSellPEPS({
  lots: DEFAULT_LOTS,
  t: refDN,
  r: calibInferRate.rNow,
  vnaFactor: vnaHoje,
  overridePU: calibInferRate.pNow,
  custodyConfig: { custMode: 'single', cust1: 0.50 }
});

const sellHojeParcial50 = simulateSellPEPS({
  lots: DEFAULT_LOTS,
  t: refDN,
  r: calibInferRate.rNow,
  vnaFactor: vnaHoje,
  qtyToSell: 50,
  overridePU: calibInferRate.pNow,
  custodyConfig: { custMode: 'single', cust1: 0.50 }
});

const simDN2Years = addYearsDN(refDN, 2);
const vna2Years = getVNAFactor(simDN2Years, refDN, fRef, 4.5);
const rAtSale2Years = calcRateAtSale({
  refDN,
  simDN: simDN2Years,
  rNow: calibInferRate.rNow,
  targetRatePct: 6.55,
  convMonths: 24,
  spread: 0
});

const sellFuturoTotal = simulateSellPEPS({
  lots: DEFAULT_LOTS,
  t: simDN2Years,
  r: rAtSale2Years,
  vnaFactor: vna2Years,
  custodyConfig: { custMode: 'single', cust1: 0.50 }
});

const decompHoje = decomposeCarryAndMtM({
  simRes: sellHojeTotal,
  simDN: refDN,
  vnaFactor: vnaHoje
});

const decompFuturo = decomposeCarryAndMtM({
  simRes: sellFuturoTotal,
  simDN: simDN2Years,
  vnaFactor: vna2Years
});

// 7. Métricas (XIRR, Breakeven, Sensibilidade)
const xirrFlows = [
  ...DEFAULT_LOTS.map(l => ({ dn: toDayNum(l.date), amount: -trunc2(l.qty * l.price) })),
  { dn: refDN, amount: sellHojeTotal.liqReal }
];
const xirrHoje = calcXIRR(xirrFlows);

const breakevenRateHoje = calcBreakevenRate({
  lots: DEFAULT_LOTS,
  simDN: refDN,
  vnaFactor: vnaHoje,
  custodyConfig: { custMode: 'single', cust1: 0.50 }
});

const sensibilidadeHoje = calcSensitivityTable({
  refDN,
  rNow: calibInferRate.rNow,
  pNow: calibInferRate.pNow,
  vnaFactor: vnaHoje,
  lots: DEFAULT_LOTS,
  shocks: [-1.0, -0.5, -0.25, -0.10, 0.10, 0.25, 0.50, 1.0],
  custodyConfig: { custMode: 'single', cust1: 0.50 }
});

// 8. Projeção Completa (Labels e 5 curvas extraídas do projectionChart.js)
const horizonYears = 10;
const projPoints = [];
const projLabels = [];
const projYearSteps = [];

for (let y = 0; y <= horizonYears; y += 0.5) {
  const d = Math.min(addYearsDN(refDN, y), MAX_SIM_DATE);
  projPoints.push(d);
  projYearSteps.push(y);
  projLabels.push(y === 0 ? 'Hoje' : `${y}a`);
}

function getValueAtOriginal(d, rateAnnual, isCarry = false) {
  const vna = getVNAFactor(d, refDN, fRef, 4.5);
  if (isCarry) {
    let tot = 0;
    for (const l of DEFAULT_LOTS) {
      const lotRateDec = (Number(l.rate) || 0) / 100;
      tot += trunc2(l.qty * calcPU(d, lotRateDec, vna));
    }
    return tot;
  }
  const res = simulateSellPEPS({
    lots: DEFAULT_LOTS,
    t: d,
    r: rateAnnual,
    vnaFactor: vna,
    custodyConfig: { custMode: 'single', cust1: 0.50 }
  });
  return res.liqReal;
}

const posLiqToday = sellHojeTotal.liqReal;
const cdiAnnualRate = 10.75 / 100;
function getCdiValueAtOriginal(y) {
  if (y === 0) return posLiqToday;
  const days = y * 365.25;
  const grossVal = posLiqToday * Math.pow(1 + cdiAnnualRate, y);
  const gain = Math.max(0, grossVal - posLiqToday);
  const irRate = days <= 180 ? 0.225 : days <= 360 ? 0.20 : days <= 720 ? 0.175 : 0.15;
  return posLiqToday + gain * (1 - irRate);
}

const projCurvas = {
  labels: projLabels,
  series: {
    alvo: projPoints.map(d => getValueAtOriginal(d, 0.0655)),
    carrego: projPoints.map(d => getValueAtOriginal(d, 0, true)),
    cdi: projPoints.map((d, i) => getCdiValueAtOriginal(projYearSteps[i])),
    queda5: projPoints.map(d => getValueAtOriginal(d, 0.05)),
    alta8: projPoints.map(d => getValueAtOriginal(d, 0.08))
  }
};

const goldenMasterData = {
  metadata: {
    generatedAt: new Date().toISOString(),
    sourceRepo: 'tesouro-renda-mais-reference-engine',
    engineVersion: 'original-js-1:1'
  },
  easterTests,
  busDayTests,
  getBusDaysPairs,
  bondGrid,
  calibration: {
    calibWithRate,
    calibInferRate,
    vnaPoints
  },
  scenarios,
  taxes: taxTests,
  portfolio: {
    sellHojeTotal,
    sellHojeParcial50,
    sellFuturoTotal,
    decompHoje,
    decompFuturo
  },
  metrics: {
    xirrHoje,
    breakevenRateHoje,
    sensibilidadeHoje
  },
  projection: projCurvas
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetDir = resolve(__dirname, '../../src/app/core/financial-engine/__fixtures__');
mkdirSync(targetDir, { recursive: true });

const targetFile = resolve(targetDir, 'golden-renda-mais.json');
writeFileSync(targetFile, JSON.stringify(goldenMasterData, null, 2), 'utf-8');

console.log(`Golden Master gerado com sucesso em: ${targetFile}`);
