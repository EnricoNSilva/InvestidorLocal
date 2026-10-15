import { buildProjectionCurves } from './projection';
import { toDayNum } from './dates';
import type { EngineLot } from './types';

describe('Financial Engine: Projeção de Curvas e Benchmark CDI', () => {
  const lots: EngineLot[] = [
    { id: '1', date: '2026-01-23', rate: 6.99, price: 185.02, qty: 25.35 },
  ];
  const refDN = toDayNum('2026-10-05');
  const Fref = 1.0;

  it('calcula as 5 curvas de projeção com labels corretos', () => {
    const res = buildProjectionCurves({
      refDN,
      Fref,
      lots,
      horizonYears: 10,
      targetRatePct: 6.55,
      ipca: 4.5,
      cdiRatePct: 10.75,
      posLiqToday: 32000,
    });

    expect(res.labels[0]).toBe('Hoje');
    expect(res.labels[1]).toBe('0.5a');
    expect(res.series.alvo.length).toBe(res.labels.length);
    expect(res.series.carrego.length).toBe(res.labels.length);
    expect(res.series.cdi.length).toBe(res.labels.length);
    expect(res.series.queda5.length).toBe(res.labels.length);
    expect(res.series.alta8.length).toBe(res.labels.length);

    expect(res.series.cdi[0]).toBeCloseTo(32000, 0);
  });

  it('suporta modo valor real com deflator de IPCA', () => {
    const res = buildProjectionCurves({
      refDN,
      Fref,
      lots,
      horizonYears: 10,
      isReal: true,
      posLiqToday: 32000,
    });

    expect(res.series.cdi.length).toBeGreaterThan(0);
    expect(res.series.alvo.length).toBeGreaterThan(0);
  });
});
