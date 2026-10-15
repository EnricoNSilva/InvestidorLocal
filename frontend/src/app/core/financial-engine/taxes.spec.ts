import { getIRRate, getIRSchedule, calcIOF, calcCustodyFee, taxProfileFrom, irRateFor } from './taxes';

describe('Financial Engine: Tributação e Custódia B3', () => {
  it('aplica as alíquotas corretas da tabela regressiva de IR', () => {
    expect(getIRRate(1)).toBe(0.225);
    expect(getIRRate(180)).toBe(0.225);
    expect(getIRRate(181)).toBe(0.2);
    expect(getIRRate(360)).toBe(0.2);
    expect(getIRRate(361)).toBe(0.175);
    expect(getIRRate(720)).toBe(0.175);
    expect(getIRRate(721)).toBe(0.15);
    expect(getIRRate(3650)).toBe(0.15);
  });

  it('retorna cronograma de IR regressivo e contagem regressiva para próxima faixa', () => {
    const sched100 = getIRSchedule(100);
    expect(sched100.rate).toBe(0.225);
    expect(sched100.nextRate).toBe(0.2);
    expect(sched100.daysRemaining).toBe(81);
    expect(sched100.statusText).toBe('81d p/ 20%');

    const sched250 = getIRSchedule(250);
    expect(sched250.rate).toBe(0.2);
    expect(sched250.nextRate).toBe(0.175);
    expect(sched250.daysRemaining).toBe(111);

    const sched500 = getIRSchedule(500);
    expect(sched500.rate).toBe(0.175);
    expect(sched500.nextRate).toBe(0.15);
    expect(sched500.daysRemaining).toBe(221);

    const sched800 = getIRSchedule(800);
    expect(sched800.rate).toBe(0.15);
    expect(sched800.nextRate).toBeNull();
    expect(sched800.daysRemaining).toBe(0);
  });

  it('aplica a tabela regressiva de IOF para prazos menores que 30 dias', () => {
    expect(calcIOF(1000, 1)).toBe(960); // 96%
    expect(calcIOF(1000, 15)).toBe(500); // 50%
    expect(calcIOF(1000, 29)).toBe(30); // 3%
    expect(calcIOF(1000, 30)).toBe(0); // Isento no 30º dia
    expect(calcIOF(1000, 45)).toBe(0);
    expect(calcIOF(-500, 5)).toBe(0); // Sem ganho não há IOF
  });

  it('calcula a taxa de custódia B3 com modelo de alíquota única (single)', () => {
    const fee = calcCustodyFee(34153.5, 255, { custMode: 'single', cust1: 0.5 });
    expect(fee).toBe(119.3);

    const fee12Years = calcCustodyFee(50000, 4380, {
      custMode: 'single',
      cust1: 0.5,
      cust2: 0.2,
    });
    expect(fee12Years).toBe(1200);

    expect(calcCustodyFee(50000, 300, { custMode: 'none' })).toBe(0);
  });

  it('calcula a taxa de custódia B3 com modelo escalonado marginal', () => {
    const feeMarginal = calcCustodyFee(50000, 4380, {
      custMode: 'marginal',
      cust1: 0.5,
      cust2: 0.2,
      cust3: 0.1,
    });
    expect(feeMarginal).toBe(2701.02);
  });

  it('TaxProfile suporta isenção de IR para instrumentos isentos (ex: LCI/LCA)', () => {
    const isentoProfile = taxProfileFrom({ isentoIr: true, cobraCustodiaB3: false }, {});
    expect(isentoProfile.ir).toBe('ISENTO');
    expect(irRateFor(isentoProfile, 10)).toBe(0);
    expect(irRateFor(isentoProfile, 500)).toBe(0);

    const tributadoProfile = taxProfileFrom({ isentoIr: false, cobraCustodiaB3: true }, {});
    expect(tributadoProfile.ir).toBe('REGRESSIVO');
    expect(irRateFor(tributadoProfile, 10)).toBe(0.225);
  });
});
