import {
  CASH_FLOWS,
  FIRST_FLOW,
  LAST_FLOW,
  calcAnnuityFactor,
  calcPU,
  calcModifiedDuration,
  trunc2,
} from './bond';
import { toDayNum, dayNumToIso } from './dates';
import { isBusDay } from './calendar';

describe('Financial Engine: Título NTN-B1 RENDA+ 2065', () => {
  it('contém exatamente 240 fluxos mensais e todos são dias úteis', () => {
    expect(CASH_FLOWS.length).toBe(240);
    for (const f of CASH_FLOWS) {
      expect(isBusDay(f)).toBe(true);
    }

    // Primeiro fluxo: 15/01/2065 (quinta-feira, dia útil)
    expect(dayNumToIso(FIRST_FLOW)).toBe('2065-01-15');

    // Último fluxo: 15/12/2084 (sexta-feira, dia útil)
    expect(dayNumToIso(LAST_FLOW)).toBe('2084-12-15');
  });

  it('o fator de anuidade é estritamente decrescente em relação à taxa de juros', () => {
    const t = toDayNum('2026-10-05');
    const fLow = calcAnnuityFactor(t, 0.05);
    const fMid = calcAnnuityFactor(t, 0.0655);
    const fHigh = calcAnnuityFactor(t, 0.08);

    expect(fLow).toBeGreaterThan(fMid);
    expect(fMid).toBeGreaterThan(fHigh);
  });

  it('o fator de anuidade cresce com a passagem do tempo se a taxa for constante (aproximação do fluxo)', () => {
    const t1 = toDayNum('2026-10-05');
    const t2 = toDayNum('2027-10-05');
    const r = 0.0655;

    expect(calcAnnuityFactor(t2, r)).toBeGreaterThan(calcAnnuityFactor(t1, r));
  });

  it('calcula a duration modificada próxima de 40-45 anos na data atual', () => {
    const t = toDayNum('2026-10-05');
    const r = 0.0655;
    const dur = calcModifiedDuration(t, r);

    expect(dur).toBeGreaterThan(38);
    expect(dur).toBeLessThan(48);
  });

  it('trunca valores monetários em duas casas decimais com precisão', () => {
    expect(trunc2(123.456)).toBe(123.45);
    expect(trunc2(123.45000001)).toBe(123.45);
    expect(trunc2(100.999)).toBe(100.99);
  });
});
