import {
  calcReturnPct,
  calcRealReturn,
  calcXIRR,
  calcBreakevenRate,
  calcSensitivityTable,
} from './metrics';
import { toDayNum } from './dates';
import { calibrateModel, getVNAFactor } from './calibration';
import type { EngineLot } from './types';

describe('Financial Engine: Métricas & Análise de Risco', () => {
  it('calcula a rentabilidade percentual simples', () => {
    expect(calcReturnPct(130, 100)).toBeCloseTo(0.3, 4);
    expect(calcReturnPct(32147.92, 24658.9)).toBeCloseTo(0.3037, 4);
    expect(calcReturnPct(0, 100)).toBe(-1.0);
  });

  it('calcula o retorno real deduzindo a inflação via relação de Fisher', () => {
    const realRet = calcRealReturn(0.3, 0.05);
    expect(realRet).toBeCloseTo(0.2381, 4);
  });

  it('calcula a Taxa Interna de Retorno (TIR / XIRR) anualizada para fluxos de caixa reais', () => {
    const d0 = toDayNum('2026-01-01');
    const d1 = toDayNum('2027-01-01');
    const flows = [
      { dn: d0, amount: -10000 },
      { dn: d1, amount: 11000 },
    ];

    const tir = calcXIRR(flows);
    expect(tir).toBeCloseTo(0.1, 2);
  });

  it('calcula a taxa de empate (breakeven) onde o investidor não tem prejuízo', () => {
    const lots: EngineLot[] = [
      { id: '1', date: '2026-01-23', rate: 6.99, price: 185.02, qty: 25.35 },
      { id: '2', date: '2026-03-24', rate: 7.14, price: 177.03, qty: 56.48 },
      { id: '3', date: '2026-06-08', rate: 7.27, price: 172.89, qty: 28.92 },
      { id: '4', date: '2026-07-30', rate: 7.37, price: 168.02, qty: 29.58 },
    ];
    const refDate = '2026-10-05';
    const cal = calibrateModel({ refDate, refPrice: 243.38, lots });
    const vnaFactor = getVNAFactor(cal.refDN, cal.refDN, cal.Fref, 4.5);

    const beRate = calcBreakevenRate({
      lots,
      simDN: cal.refDN,
      vnaFactor,
      custodyConfig: { custMode: 'single', cust1: 0.5 },
    });

    expect(beRate).not.toBeNull();
    expect(beRate!).toBeGreaterThan(0.0655);
  });

  it('gera a tabela de sensibilidade com variações coerentes com a duration', () => {
    const lots: EngineLot[] = [
      { id: '1', date: '2026-01-23', rate: 6.99, price: 185.02, qty: 25.35 },
      { id: '2', date: '2026-03-24', rate: 7.14, price: 177.03, qty: 56.48 },
      { id: '3', date: '2026-06-08', rate: 7.27, price: 172.89, qty: 28.92 },
      { id: '4', date: '2026-07-30', rate: 7.37, price: 168.02, qty: 29.58 },
    ];
    const cal = calibrateModel({ refDate: '2026-10-05', refPrice: 243.38, lots });
    const vnaFactor = getVNAFactor(cal.refDN, cal.refDN, cal.Fref, 4.5);

    const table = calcSensitivityTable({
      refDN: cal.refDN,
      rNow: cal.rNow,
      pNow: cal.pNow,
      vnaFactor,
      lots,
      shocks: [-1.0, 1.0],
    });

    expect(table.length).toBe(2);

    const shockDown = table[0];
    expect(shockDown.shock).toBe(-1.0);
    expect(shockDown.newPU).toBeGreaterThan(cal.pNow);
    expect(shockDown.brutoDiff).toBeGreaterThan(0);
    expect(shockDown.puVarPct).toBeGreaterThan(0.15);

    const shockUp = table[1];
    expect(shockUp.shock).toBe(1.0);
    expect(shockUp.newPU).toBeLessThan(cal.pNow);
    expect(shockUp.brutoDiff).toBeLessThan(0);
  });
});
