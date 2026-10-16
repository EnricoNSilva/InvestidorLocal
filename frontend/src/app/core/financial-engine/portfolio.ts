/**
 * Motor Financeiro - Módulo de Carteira & Liquidação PEPS (FIFO)
 * Simula a venda total ou parcial de títulos respeitando a ordem cronológica de aquisição.
 */

import { toDayNum } from './dates';
import { trunc2, calcPU } from './bond';
import { calcCustodyFee, calcIOF, getIRRate } from './taxes';
import type {
  CarryMtMDecomposition,
  CustodyConfig,
  DayNum,
  EngineLot,
  SellPart,
  SellResult,
} from './types';
import type { FixedIncomeInstrument, PricingContext } from './instruments/instrument';
import { createRendaMaisInstrument } from './instruments/renda-mais';
import { RENDA_MAIS_2065 } from './annuity-schedule';

/**
 * Simula a venda de títulos por liquidação PEPS (Primeiro que Entra, Primeiro que Sai).
 * Implementação original e idêntica de portfolio.js.
 * @param params
 * @param params.lots - Lista de lotes [{ id, date, rate, price, qty }]
 * @param params.t - Data de liquidação em dia numérico UTC
 * @param params.r - Taxa de resgate em decimal (ex: 0.0655)
 * @param params.vnaFactor - Fator de escala do VNA na data t
 * @param params.qtyToSell - Quantidade máxima a vender (venda parcial ou total)
 * @param params.custodyConfig - Configurações da taxa de custódia B3
 * @param params.overridePU - PU explícito a usar (opcional, ex: no dia de calibração)
 * @returns Detalhamento por lote e totais consolidados
 */
export function simulateSellPEPS({
  lots = [],
  t,
  r,
  vnaFactor,
  qtyToSell = Infinity,
  custodyConfig = {},
  overridePU = null,
}: {
  lots?: EngineLot[];
  t: DayNum;
  r: number;
  vnaFactor: number;
  qtyToSell?: number;
  custodyConfig?: CustodyConfig;
  overridePU?: number | null;
}): SellResult {
  const pu =
    overridePU !== null && !isNaN(Number(overridePU))
      ? Number(overridePU)
      : calcPU(t, r, vnaFactor);

  const activeLots = (lots || [])
    .map((lot) => ({
      ...lot,
      dn: typeof lot.dn === 'number' ? lot.dn : toDayNum(lot.date),
    }))
    .filter((lot) => lot.dn <= t)
    .sort((a, b) => a.dn - b.dn);

  let left = Number(qtyToSell) > 0 ? Number(qtyToSell) : Infinity;
  const parts: SellPart[] = [];

  for (const lot of activeLots) {
    if (left <= 1e-9) break;

    const q = Math.min(lot.qty, left);
    left -= q;

    const bruto = trunc2(q * pu);
    const custo = trunc2(q * lot.price);
    const days = Math.max(0, t - lot.dn);
    const cust = calcCustodyFee(bruto, days, custodyConfig);
    const ganho = bruto - custo - cust;
    const iof = calcIOF(ganho, days);
    const baseIR = Math.max(ganho - iof, 0);
    const irAliq = getIRRate(days);
    const ir = trunc2(baseIR * irAliq);

    // Cálculo estilo App oficial do Tesouro (IR apurado sem abater a taxa de custódia)
    const ganhoApp = Math.max(bruto - custo, 0);
    const irApp = trunc2(ganhoApp * irAliq);

    parts.push({
      lot,
      q,
      pu,
      bruto,
      custo,
      days,
      cust,
      iof,
      ir,
      irAliq,
      irApp,
      liqReal: bruto - cust - iof - ir,
      liqApp: bruto - iof - irApp,
    });
  }

  const sum = (key: keyof Omit<SellPart, 'lot'>): number =>
    parts.reduce((acc, p) => acc + (p[key] || 0), 0);

  return {
    parts,
    pu,
    q: sum('q'),
    bruto: sum('bruto'),
    custo: sum('custo'),
    cust: sum('cust'),
    iof: sum('iof'),
    ir: sum('ir'),
    irApp: sum('irApp'),
    liqReal: sum('liqReal'),
    liqApp: sum('liqApp'),
  };
}

/**
 * Simula a venda genérica parametrizada por instrumento FixedIncomeInstrument.
 */
export function simulateSell({
  lots,
  t,
  instrument,
  ctx,
  qtyToSell = Infinity,
  overridePU = null,
}: {
  lots: EngineLot[];
  t: DayNum;
  instrument: FixedIncomeInstrument;
  ctx: PricingContext;
  qtyToSell?: number;
  overridePU?: number | null;
}): SellResult {
  const activeLots = (lots || [])
    .map((lot) => ({
      ...lot,
      dn: typeof lot.dn === 'number' ? lot.dn : toDayNum(lot.date),
    }))
    .filter((lot) => lot.dn <= t)
    .sort((a, b) => a.dn - b.dn);

  let left = Number(qtyToSell) > 0 ? Number(qtyToSell) : Infinity;
  const parts: SellPart[] = [];

  for (const lot of activeLots) {
    if (left <= 1e-9) break;

    const q = Math.min(lot.qty, left);
    left -= q;

    const pu =
      overridePU !== null && !isNaN(Number(overridePU))
        ? Number(overridePU)
        : instrument.puVenda(t, lot, ctx);

    const bruto = trunc2(q * pu);
    const custo = trunc2(q * lot.price);
    const days = Math.max(0, t - lot.dn);
    const cust = instrument.taxProfile.custody
      ? calcCustodyFee(bruto, days, instrument.taxProfile.custody)
      : 0;
    const ganho = bruto - custo - cust;
    const iof = instrument.taxProfile.iof ? calcIOF(ganho, days) : 0;
    const baseIR = Math.max(ganho - iof, 0);
    const irAliq = instrument.taxProfile.ir === 'ISENTO' ? 0 : getIRRate(days);
    const ir = trunc2(baseIR * irAliq);

    const ganhoApp = Math.max(bruto - custo, 0);
    const irApp = trunc2(ganhoApp * irAliq);

    parts.push({
      lot,
      q,
      pu,
      bruto,
      custo,
      days,
      cust,
      iof,
      ir,
      irAliq,
      irApp,
      liqReal: bruto - cust - iof - ir,
      liqApp: bruto - iof - irApp,
    });
  }

  const sum = (key: keyof Omit<SellPart, 'lot'>): number =>
    parts.reduce((acc, p) => acc + (p[key] || 0), 0);

  const defaultPU =
    overridePU !== null && !isNaN(Number(overridePU))
      ? Number(overridePU)
      : parts.length > 0
        ? parts[0].pu
        : 0;

  return {
    parts,
    pu: defaultPU,
    q: sum('q'),
    bruto: sum('bruto'),
    custo: sum('custo'),
    cust: sum('cust'),
    iof: sum('iof'),
    ir: sum('ir'),
    irApp: sum('irApp'),
    liqReal: sum('liqReal'),
    liqApp: sum('liqApp'),
  };
}

/**
 * Decompõe o resultado financeiro da venda entre Carrego Puro e Marcação a Mercado.
 * @param params
 * @param params.simRes - Resultado retornado por simulateSellPEPS ou simulateSell
 * @param params.simDN - Data da venda
 * @param params.vnaFactor - Fator VNA na data simDN (opcional se ctx for fornecido)
 * @param params.instrument - Instrumento opcional
 * @param params.ctx - Contexto de precificação opcional
 */
export function decomposeCarryAndMtM({
  simRes,
  simDN,
  vnaFactor = 1,
  instrument,
  ctx,
}: {
  simRes: SellResult;
  simDN: DayNum;
  vnaFactor?: number;
  instrument?: FixedIncomeInstrument;
  ctx?: PricingContext;
}): CarryMtMDecomposition {
  let ganhoCarrego = 0;

  for (const p of simRes.parts) {
    let puCarrego: number;
    if (instrument) {
      const pricingCtx: PricingContext = {
        marketRate: 0,
        vnaFactor,
        ...ctx,
      };
      puCarrego = instrument.puCarrego(simDN, p.lot, pricingCtx);
    } else {
      const lotRateDec = (Number(p.lot.rate) || 0) / 100;
      puCarrego = calcPU(simDN, lotRateDec, vnaFactor);
    }
    ganhoCarrego += trunc2(p.q * puCarrego) - p.custo;
  }

  const ganhoBrutoTotal = simRes.bruto - simRes.custo;

  if (instrument && !instrument.supportsMtM) {
    return {
      ganhoBrutoTotal,
      ganhoCarrego: ganhoBrutoTotal,
      ganhoMarcacao: 0,
      pctCarrego: ganhoBrutoTotal !== 0 ? 1.0 : 0,
      pctMarcacao: 0,
    };
  }

  const ganhoMarcacao = ganhoBrutoTotal - ganhoCarrego;

  const pctCarrego = ganhoBrutoTotal !== 0 ? ganhoCarrego / ganhoBrutoTotal : 0;
  const pctMarcacao = ganhoBrutoTotal !== 0 ? ganhoMarcacao / ganhoBrutoTotal : 0;

  return {
    ganhoBrutoTotal,
    ganhoCarrego,
    ganhoMarcacao,
    pctCarrego,
    pctMarcacao,
  };
}
