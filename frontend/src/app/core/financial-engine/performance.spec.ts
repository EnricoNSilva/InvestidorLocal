import {
  calibrateModel,
  getVNAFactor,
  simulateSellPEPS,
  decomposeCarryAndMtM,
  buildProjectionCurves,
  calcSensitivityTable,
  toDayNum,
  DEFAULT_LOTS,
} from './index';

describe('Financial Engine: Performance Budget (mediana < 4 ms)', () => {
  it('recálculo completo em 200 iterações tem mediana inferior a 4 ms', () => {
    const refDate = '2026-10-05';
    const refDN = toDayNum(refDate);
    const lots = DEFAULT_LOTS;
    const shocks = [-1.0, -0.5, -0.25, -0.1, 0.1, 0.25, 0.5, 1.0];

    // Aquecimento (warmup) JIT
    for (let i = 0; i < 20; i++) {
      const cal = calibrateModel({ refDate, refPrice: 243.38, lots, ipcaCal: 4.5 });
      const vnaHoje = getVNAFactor(refDN, refDN, cal.Fref, 4.5);
      const res = simulateSellPEPS({ lots, t: refDN, r: cal.rNow, vnaFactor: vnaHoje });
      decomposeCarryAndMtM({ simRes: res, simDN: refDN, vnaFactor: vnaHoje });
      calcSensitivityTable({
        refDN,
        rNow: cal.rNow,
        pNow: cal.pNow,
        vnaFactor: vnaHoje,
        lots,
        shocks,
      });
      buildProjectionCurves({ refDN, Fref: cal.Fref, lots, posLiqToday: res.liqReal });
    }

    const durations: number[] = [];
    const iterations = 200;

    for (let i = 0; i < iterations; i++) {
      // Simula arraste de slider variando refPrice ligeiramente
      const price = 240 + (i % 10) * 0.8;
      const t0 = performance.now();

      const cal = calibrateModel({ refDate, refPrice: price, lots, ipcaCal: 4.5 });
      const vnaHoje = getVNAFactor(refDN, refDN, cal.Fref, 4.5);
      const res = simulateSellPEPS({
        lots,
        t: refDN,
        r: cal.rNow,
        vnaFactor: vnaHoje,
        custodyConfig: { custMode: 'single', cust1: 0.5 },
      });
      decomposeCarryAndMtM({ simRes: res, simDN: refDN, vnaFactor: vnaHoje });
      calcSensitivityTable({
        refDN,
        rNow: cal.rNow,
        pNow: cal.pNow,
        vnaFactor: vnaHoje,
        lots,
        shocks,
        custodyConfig: { custMode: 'single', cust1: 0.5 },
      });
      buildProjectionCurves({
        refDN,
        Fref: cal.Fref,
        lots,
        custodyConfig: { custMode: 'single', cust1: 0.5 },
        posLiqToday: res.liqReal,
      });

      const t1 = performance.now();
      durations.push(t1 - t0);
    }

    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];

    console.log(`[PERF TEST] Mediana de recálculo completo (200 iterações): ${median.toFixed(3)} ms`);
    expect(median).toBeLessThan(4.0);
  });
});
