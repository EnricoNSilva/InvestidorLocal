import golden from './__fixtures__/golden-renda-mais.json';
import {
  getEaster,
  isBusDay,
  nextBusDay,
  getBusDays,
  dayNumToIso,
  formatBRLDate,
  diffDays,
  diffYears,
  calcAnnuityFactor,
  calcPU,
  calcModifiedDuration,
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
  calcXIRR,
  calcBreakevenRate,
  calcSensitivityTable,
  buildProjectionCurves,
} from './index';

describe('Financial Engine: Golden Master Parity Verification', () => {
  it('Páscoa e feriados: paridade exata com JS original', () => {
    for (const test of golden.easterTests) {
      const easter = getEaster(test.year);
      expect(easter).toBe(test.easterDN);
      expect(dayNumToIso(easter)).toBe(test.easterIso);
    }

    for (const test of golden.busDayTests) {
      expect(isBusDay(test.dn)).toBe(test.isBus);
      expect(nextBusDay(test.dn)).toBe(test.nextBus);
      expect(formatBRLDate(test.dn)).toBe(test.formatBRL);
    }

    for (const pair of golden.getBusDaysPairs) {
      expect(getBusDays(pair.dna, pair.dnb)).toBe(pair.busDays);
      expect(diffDays(pair.dna, pair.dnb)).toBe(pair.diffD);
      expect(diffYears(pair.dna, pair.dnb)).toBeCloseTo(pair.diffY, 12);
    }
  });

  it('NTN-B1 / Bond grid: paridade de PU (toBe), anuidade e duration (relativo <= 1e-12)', () => {
    for (const row of golden.bondGrid) {
      const annuity = calcAnnuityFactor(row.t, row.r);
      const pu = calcPU(row.t, row.r, 1.05);
      const modDuration = calcModifiedDuration(row.t, row.r);

      // PU monetário truncado: toBe
      expect(pu).toBe(row.pu);

      // Floats contínuos: erro relativo <= 1e-12
      const relDiffAnnuity = Math.abs(annuity - row.annuityFactor) / row.annuityFactor;
      expect(relDiffAnnuity).toBeLessThanOrEqual(1e-12);

      const relDiffDur = Math.abs(modDuration - row.modDuration) / row.modDuration;
      expect(relDiffDur).toBeLessThanOrEqual(1e-12);
    }
  });

  it('Calibração e VNA: paridade exata de PU/Fref e taxa implícita', () => {
    const calWithRate = calibrateModel({
      refDate: '2026-10-05',
      refPrice: 243.38,
      refRate: 6.55,
      lots: (golden.portfolio.sellHojeTotal.parts as any[]).map((p) => p.lot),
      ipcaCal: 4.5,
    });
    expect(calWithRate.refDN).toBe(golden.calibration.calibWithRate.refDN);
    expect(calWithRate.pNow).toBe(golden.calibration.calibWithRate.pNow);
    expect(calWithRate.rNow).toBe(golden.calibration.calibWithRate.rNow);
    expect(Math.abs(calWithRate.Fref - golden.calibration.calibWithRate.Fref)).toBeLessThanOrEqual(
      1e-12
    );

    const calInfer = calibrateModel({
      refDate: '2026-10-05',
      refPrice: 243.38,
      refRate: '',
      lots: (golden.portfolio.sellHojeTotal.parts as any[]).map((p) => p.lot),
      ipcaCal: 4.5,
    });
    expect(calInfer.refDN).toBe(golden.calibration.calibInferRate.refDN);
    expect(calInfer.pNow).toBe(golden.calibration.calibInferRate.pNow);
    expect(Math.abs(calInfer.rNow - golden.calibration.calibInferRate.rNow)).toBeLessThanOrEqual(
      1e-12
    );
    expect(Math.abs(calInfer.Fref - golden.calibration.calibInferRate.Fref)).toBeLessThanOrEqual(
      1e-12
    );

    for (const v of golden.calibration.vnaPoints) {
      const vna45 = getVNAFactor(v.t, v.refDN, v.fRef, 4.5);
      const vna60 = getVNAFactor(v.t, v.refDN, v.fRef, 6.0);
      expect(Math.abs(vna45 - v.vna4_5) / v.vna4_5).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(vna60 - v.vna6_0) / v.vna6_0).toBeLessThanOrEqual(1e-12);
    }
  });

  it('Cenários e Trajetórias: paridade exata', () => {
    for (const sc of golden.scenarios) {
      const rAtSale = calcRateAtSale({
        refDN: golden.calibration.calibInferRate.refDN,
        simDN: golden.calibration.calibInferRate.refDN + 365,
        rNow: golden.calibration.calibInferRate.rNow,
        targetRatePct: sc.targetRatePct,
        convMonths: sc.convMonths,
        spread: sc.spread,
      });
      expect(Math.abs(rAtSale - sc.rAtSale)).toBeLessThanOrEqual(1e-12);

      const traj = generateRateTrajectory({
        rNow: golden.calibration.calibInferRate.rNow,
        targetRatePct: sc.targetRatePct,
        convMonths: sc.convMonths,
        spread: sc.spread,
        horizonMonths: 24,
        stepMonths: 6,
      });
      expect(traj.length).toBe(sc.traj.length);
      for (let i = 0; i < traj.length; i++) {
        expect(traj[i].month).toBe(sc.traj[i].month);
        expect(traj[i].label).toBe(sc.traj[i].label);
        expect(Math.abs(traj[i].ratePct - sc.traj[i].ratePct)).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  it('Tributos e Custódia B3: paridade exata (toBe para valores truncados)', () => {
    for (const t of golden.taxes) {
      expect(getIRRate(t.days)).toBe(t.irRate);
      expect(getIRSchedule(t.days)).toEqual(t.irSchedule);
      expect(calcIOF(1000, t.days)).toBe(t.iofPos);
      expect(calcIOF(0, t.days)).toBe(t.iofZero);
      expect(calcIOF(-500, t.days)).toBe(t.iofNeg);
      expect(
        calcCustodyFee(34153.5, t.days, {
          custMode: 'single',
          cust1: 0.5,
          cust2: 0.2,
          cust3: 0.1,
        })
      ).toBe(t.custSingle);
      expect(
        calcCustodyFee(34153.5, t.days, {
          custMode: 'marginal',
          cust1: 0.5,
          cust2: 0.2,
          cust3: 0.1,
        })
      ).toBe(t.custMarginal);
      expect(calcCustodyFee(34153.5, t.days, { custMode: 'none' })).toBe(t.custNone);
    }
  });

  it('Portfólio / PEPS: paridade centavo a centavo (toBe em todos os totais)', () => {
    const defaultLots = (golden.portfolio.sellHojeTotal.parts as any[]).map((p) => p.lot);

    // Venda Hoje Total
    const sellHoje = simulateSellPEPS({
      lots: defaultLots,
      t: golden.calibration.calibInferRate.refDN,
      r: golden.calibration.calibInferRate.rNow,
      vnaFactor: golden.calibration.vnaPoints[4].vna4_5,
      overridePU: golden.calibration.calibInferRate.pNow,
      custodyConfig: { custMode: 'single', cust1: 0.5 },
    });
    expect(sellHoje.pu).toBe(golden.portfolio.sellHojeTotal.pu);
    expect(sellHoje.q).toBe(golden.portfolio.sellHojeTotal.q);
    expect(sellHoje.bruto).toBe(golden.portfolio.sellHojeTotal.bruto);
    expect(sellHoje.custo).toBe(golden.portfolio.sellHojeTotal.custo);
    expect(sellHoje.cust).toBe(golden.portfolio.sellHojeTotal.cust);
    expect(sellHoje.iof).toBe(golden.portfolio.sellHojeTotal.iof);
    expect(sellHoje.ir).toBe(golden.portfolio.sellHojeTotal.ir);
    expect(sellHoje.irApp).toBe(golden.portfolio.sellHojeTotal.irApp);
    expect(sellHoje.liqReal).toBe(golden.portfolio.sellHojeTotal.liqReal);
    expect(sellHoje.liqApp).toBe(golden.portfolio.sellHojeTotal.liqApp);

    // Venda Hoje Parcial 50
    const sellParcial = simulateSellPEPS({
      lots: defaultLots,
      t: golden.calibration.calibInferRate.refDN,
      r: golden.calibration.calibInferRate.rNow,
      vnaFactor: golden.calibration.vnaPoints[4].vna4_5,
      qtyToSell: 50,
      overridePU: golden.calibration.calibInferRate.pNow,
      custodyConfig: { custMode: 'single', cust1: 0.5 },
    });
    expect(sellParcial.pu).toBe(golden.portfolio.sellHojeParcial50.pu);
    expect(sellParcial.q).toBe(golden.portfolio.sellHojeParcial50.q);
    expect(sellParcial.bruto).toBe(golden.portfolio.sellHojeParcial50.bruto);
    expect(sellParcial.custo).toBe(golden.portfolio.sellHojeParcial50.custo);
    expect(sellParcial.cust).toBe(golden.portfolio.sellHojeParcial50.cust);
    expect(sellParcial.ir).toBe(golden.portfolio.sellHojeParcial50.ir);
    expect(sellParcial.liqReal).toBe(golden.portfolio.sellHojeParcial50.liqReal);
    expect(sellParcial.liqApp).toBe(golden.portfolio.sellHojeParcial50.liqApp);

    // Decomposição
    const decomp = decomposeCarryAndMtM({
      simRes: sellHoje,
      simDN: golden.calibration.calibInferRate.refDN,
      vnaFactor: golden.calibration.vnaPoints[4].vna4_5,
    });
    expect(decomp.ganhoBrutoTotal).toBe(golden.portfolio.decompHoje.ganhoBrutoTotal);
    expect(decomp.ganhoCarrego).toBe(golden.portfolio.decompHoje.ganhoCarrego);
    expect(decomp.ganhoMarcacao).toBe(golden.portfolio.decompHoje.ganhoMarcacao);
    expect(Math.abs(decomp.pctCarrego - golden.portfolio.decompHoje.pctCarrego)).toBeLessThanOrEqual(
      1e-12
    );
    expect(
      Math.abs(decomp.pctMarcacao - golden.portfolio.decompHoje.pctMarcacao)
    ).toBeLessThanOrEqual(1e-12);
  });

  it('Métricas e Sensibilidade: paridade exata', () => {
    const defaultLots = (golden.portfolio.sellHojeTotal.parts as any[]).map((p) => p.lot);
    const flows = [
      ...defaultLots.map((l: any) => ({ dn: l.dn, amount: -Math.floor(l.qty * l.price * 100) / 100 })),
      { dn: golden.calibration.calibInferRate.refDN, amount: golden.portfolio.sellHojeTotal.liqReal },
    ];
    const xirr = calcXIRR(flows);
    expect(Math.abs(xirr - golden.metrics.xirrHoje)).toBeLessThanOrEqual(1e-12);

    const beRate = calcBreakevenRate({
      lots: defaultLots,
      simDN: golden.calibration.calibInferRate.refDN,
      vnaFactor: golden.calibration.vnaPoints[4].vna4_5,
      custodyConfig: { custMode: 'single', cust1: 0.5 },
    });
    expect(Math.abs(beRate! - golden.metrics.breakevenRateHoje)).toBeLessThanOrEqual(1e-12);

    const sens = calcSensitivityTable({
      refDN: golden.calibration.calibInferRate.refDN,
      rNow: golden.calibration.calibInferRate.rNow,
      pNow: golden.calibration.calibInferRate.pNow,
      vnaFactor: golden.calibration.vnaPoints[4].vna4_5,
      lots: defaultLots,
      shocks: [-1.0, -0.5, -0.25, -0.1, 0.1, 0.25, 0.5, 1.0],
      custodyConfig: { custMode: 'single', cust1: 0.5 },
    });
    expect(sens.length).toBe(golden.metrics.sensibilidadeHoje.length);
    for (let i = 0; i < sens.length; i++) {
      expect(sens[i].shock).toBe(golden.metrics.sensibilidadeHoje[i].shock);
      expect(sens[i].newPU).toBe(golden.metrics.sensibilidadeHoje[i].newPU);
      expect(sens[i].bruto).toBe(golden.metrics.sensibilidadeHoje[i].bruto);
      expect(sens[i].brutoDiff).toBe(golden.metrics.sensibilidadeHoje[i].brutoDiff);
      expect(sens[i].liqApp).toBe(golden.metrics.sensibilidadeHoje[i].liqApp);
      expect(sens[i].liqDiff).toBe(golden.metrics.sensibilidadeHoje[i].liqDiff);
    }
  });

  it('Projeção de 5 curvas: paridade exata em todas as séries', () => {
    const defaultLots = (golden.portfolio.sellHojeTotal.parts as any[]).map((p) => p.lot);
    const proj = buildProjectionCurves({
      refDN: golden.calibration.calibInferRate.refDN,
      Fref: golden.calibration.calibInferRate.Fref,
      lots: defaultLots,
      custodyConfig: { custMode: 'single', cust1: 0.5 },
      horizonYears: 10,
      targetRatePct: 6.55,
      ipca: 4.5,
      cdiRatePct: 10.75,
      posLiqToday: golden.portfolio.sellHojeTotal.liqReal,
    });

    expect(proj.labels).toEqual(golden.projection.labels);
    for (let i = 0; i < proj.series.alvo.length; i++) {
      expect(proj.series.alvo[i]).toBe(golden.projection.series.alvo[i]);
      expect(proj.series.carrego[i]).toBe(golden.projection.series.carrego[i]);
      expect(proj.series.cdi[i]).toBe(golden.projection.series.cdi[i]);
      expect(proj.series.queda5[i]).toBe(golden.projection.series.queda5[i]);
      expect(proj.series.alta8[i]).toBe(golden.projection.series.alta8[i]);
    }
  });
});
