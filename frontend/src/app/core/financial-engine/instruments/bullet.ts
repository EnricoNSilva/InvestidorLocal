// frontend/src/app/core/financial-engine/instruments/bullet.ts
import { getBusDays } from '../calendar';
import { toDayNum } from '../dates';
import { taxProfileFrom } from '../taxes';
import type { CustodyConfig, DayNum, EngineLot } from '../types';
import type { FixedIncomeInstrument, PricingContext } from './instrument';

export interface BulletInstrumentMeta {
  kind: 'PREFIXADO' | 'IPCA_BULLET';
  vencimento: DayNum;
  isentoIr: boolean;
  cobraCustodiaB3: boolean;
  supportsMtM: boolean;
  custodyConfig?: CustodyConfig;
}

export function createBulletInstrument(meta: BulletInstrumentMeta): FixedIncomeInstrument {
  const taxProfile = taxProfileFrom(
    { isentoIr: meta.isentoIr, cobraCustodiaB3: meta.cobraCustodiaB3 },
    meta.custodyConfig ?? {}
  );

  function puCarrego(t: DayNum, lot: EngineLot, ctx: PricingContext): number {
    const lotDN = typeof lot.dn === 'number' ? lot.dn : toDayNum(lot.date);
    const effectiveT = Math.min(t, meta.vencimento);
    const du = Math.max(0, getBusDays(lotDN, effectiveT));
    const lotRateDec = (Number(lot.rate) || 0) / 100;
    const ipcaDec = meta.kind === 'IPCA_BULLET' ? (ctx.ipcaAnual ?? 0.045) : 0;
    const annualFactor = (1 + ipcaDec) * (1 + lotRateDec);
    return lot.price * Math.pow(annualFactor, du / 252);
  }

  function puVenda(t: DayNum, lot: EngineLot, ctx: PricingContext): number {
    const carry = puCarrego(t, lot, ctx);
    if (!meta.supportsMtM) return carry;
    const effectiveT = Math.min(t, meta.vencimento);
    const duRem = Math.max(0, getBusDays(effectiveT, meta.vencimento));
    if (duRem === 0) return carry;
    const lotRateDec = (Number(lot.rate) || 0) / 100;
    const mktRateDec = ctx.marketRate > 0 ? ctx.marketRate : lotRateDec;
    return carry * Math.pow((1 + lotRateDec) / (1 + mktRateDec), duRem / 252);
  }

  return {
    kind: meta.kind,
    maxSimDate: meta.vencimento,
    taxProfile,
    supportsMtM: meta.supportsMtM,
    puVenda,
    puCarrego,
  };
}
