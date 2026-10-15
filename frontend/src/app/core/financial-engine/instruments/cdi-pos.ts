import { getBusDays } from '../calendar';
import type { DayNum, EngineLot } from '../types';
import type { FixedIncomeInstrument, PricingContext } from './instrument';

export function createCdiInstrument(meta: {
  vencimento: DayNum;
  isentoIr: boolean;
  cobraCustodia: boolean;
}): FixedIncomeInstrument {
  return {
    kind: 'CDI_POS',
    maxSimDate: meta.vencimento,
    taxProfile: {
      ir: meta.isentoIr ? 'ISENTO' : 'REGRESSIVO',
      iof: true,
      custody: meta.cobraCustodia ? {} : null,
    },
    puVenda(t: DayNum, lot: EngineLot, ctx: PricingContext): number {
      const du = Math.max(0, getBusDays(lot.dn ?? t, t));
      const cdi = ctx.cdiAnual ?? 0.1065;
      const pct = (Number(lot.rate) || 100) / 100;
      const dailyFactor = 1 + (Math.pow(1 + cdi, 1 / 252) - 1) * pct;
      return lot.price * Math.pow(dailyFactor, du);
    },
    puCarrego(t: DayNum, lot: EngineLot, ctx: PricingContext): number {
      return this.puVenda(t, lot, ctx);
    },
  };
}
