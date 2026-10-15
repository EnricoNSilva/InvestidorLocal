import { calcPU } from '../bond';
import { AnnuitySchedule } from '../annuity-schedule';
import type { CustodyConfig } from '../types';
import type { FixedIncomeInstrument } from './instrument';

export function createRendaMaisInstrument(
  s: AnnuitySchedule,
  custody: CustodyConfig = {}
): FixedIncomeInstrument {
  return {
    kind: 'RENDA_MAIS',
    maxSimDate: s.maxSimDate,
    taxProfile: { ir: 'REGRESSIVO', iof: true, custody },
    puVenda: (t, _lot, c) => calcPU(t, c.marketRate, c.vnaFactor!, s),
    puCarrego: (t, lot, c) => calcPU(t, (Number(lot.rate) || 0) / 100, c.vnaFactor!, s),
  };
}
