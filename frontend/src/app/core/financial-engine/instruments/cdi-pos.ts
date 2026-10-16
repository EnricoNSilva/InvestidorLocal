import { getBusDays } from '../calendar';
import { toDayNum } from '../dates';
import { taxProfileFrom } from '../taxes';
import type { CustodyConfig, DayNum, EngineLot } from '../types';
import type { FixedIncomeInstrument, PricingContext } from './instrument';

export interface CdiInstrumentMeta {
  kind?: 'CDI_POS' | 'CDI_SPREAD' | 'SELIC_POS';
  vencimento: DayNum;
  isentoIr: boolean;
  cobraCustodiaB3: boolean;
  custodyConfig?: CustodyConfig;
  /** Percentual default do indexador (ex.: 100 para 100% CDI) caso o lote não especifique */
  defaultPctCdi?: number;
}

export function round8(val: number): number {
  return Math.round((val + 1e-15) * 1e8) / 1e8;
}

export function trunc8(val: number): number {
  return Math.floor((val + 1e-14) * 1e8) / 1e8;
}

export function calcCdiFactor(du: number, cdiAnualDec: number, pctCdi: number): number {
  if (du <= 0) return 1.0;
  const dailyCdi = Math.pow(1 + cdiAnualDec, 1 / 252) - 1;
  const dailyFactor = 1 + dailyCdi * (pctCdi / 100);
  return Math.pow(dailyFactor, du);
}

export function calcCdiSpreadFactor(du: number, baseAnualDec: number, spreadPct: number): number {
  if (du <= 0) return 1.0;
  const spreadDec = spreadPct / 100;
  const combinedAnnual = (1 + baseAnualDec) * (1 + spreadDec);
  return Math.pow(combinedAnnual, du / 252);
}

export function createCdiInstrument(meta: CdiInstrumentMeta): FixedIncomeInstrument {
  const kind = meta.kind ?? 'CDI_POS';
  const taxProfile = taxProfileFrom(
    { isentoIr: meta.isentoIr, cobraCustodiaB3: meta.cobraCustodiaB3 },
    meta.custodyConfig ?? {}
  );

  function computePU(t: DayNum, lot: EngineLot, ctx: PricingContext): number {
    const lotDN = typeof lot.dn === 'number' ? lot.dn : toDayNum(lot.date);
    const effectiveT = Math.min(t, meta.vencimento);
    const du = Math.max(0, getBusDays(lotDN, effectiveT));
    const baseRate =
      kind === 'SELIC_POS'
        ? (ctx.selicAnual ?? ctx.cdiAnual ?? 0.1075)
        : (ctx.cdiAnual ?? 0.1065);

    if (kind === 'CDI_SPREAD' || kind === 'SELIC_POS') {
      const spreadPct = Number(lot.rate) || 0;
      return lot.price * calcCdiSpreadFactor(du, baseRate, spreadPct);
    }

    // CDI_POS (% do CDI): lot.rate guarda ex.: 110 para 110% do CDI
    const pct = Number(lot.rate) || meta.defaultPctCdi || 100;

    // Se a série histórica diária da B3/BCB (Série 12) estiver disponível no contexto,
    // aplica a fórmula oficial do Caderno de Fórmulas da B3/CETIP (fator C com 8 casas decimais
    // e PU truncado em 8 casas decimais) para o período passado e projeta apenas dias futuros.
    if (ctx.cdiHistorico && ctx.cdiHistorico.size > 0 && effectiveT > lotDN) {
      const maxHist = ctx.maxCdiHistDN ?? effectiveT;
      const histEndDN = Math.min(effectiveT, maxHist + 1);
      let c = 1.0;
      for (let d = lotDN; d < histEndDN; d++) {
        const tdiPct = ctx.cdiHistorico.get(d);
        if (tdiPct !== undefined) {
          const factorDia = 1 + (tdiPct / 100) * (pct / 100);
          c = round8(c * factorDia);
        }
      }
      const puHist = trunc8(lot.price * c);
      if (effectiveT <= maxHist + 1) {
        return puHist;
      }
      const duFuture = Math.max(0, getBusDays(maxHist + 1, effectiveT));
      return puHist * calcCdiFactor(duFuture, baseRate, pct);
    }

    return lot.price * calcCdiFactor(du, baseRate, pct);
  }

  return {
    kind,
    maxSimDate: meta.vencimento,
    taxProfile,
    supportsMtM: false,
    puVenda: computePU,
    puCarrego: computePU,
  };
}

