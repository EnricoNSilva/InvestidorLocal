/**
 * Tipos fundamentais do Motor Financeiro de Renda Fixa
 */

export type DayNum = number; // Dias inteiros desde 1970-01-01 UTC

export interface EngineLot {
  id: number | string;
  date: string; // 'AAAA-MM-DD'
  dn?: DayNum; // Dia numérico UTC
  rate: number; // % a.a. (IPCA+/Pré) ou % do CDI (pós)
  price: number; // PU de compra
  qty: number;
}

export type CustodyTieredMode = 'single' | 'marginal' | 'none';

export interface CustodyConfig {
  custMode?: CustodyTieredMode;
  cust1?: number; // % a.a. até 10 anos (padrão 0.50)
  cust2?: number; // % a.a. de 10 a 20 anos (padrão 0.20)
  cust3?: number; // % a.a. acima de 20 anos (padrão 0.10)
}

export interface Calibration {
  refDN: DayNum;
  rNow: number;
  Fref: number;
  pNow: number;
}

export interface SellPart {
  lot: EngineLot;
  q: number;
  pu: number;
  bruto: number;
  custo: number;
  days: number;
  cust: number;
  iof: number;
  ir: number;
  irAliq: number;
  irApp: number;
  liqReal: number; // custódia abatida da base do IR (valor que entra na conta)
  liqApp: number; // regra do app oficial (IR sobre ganho bruto, sem abater custódia)
}

export interface SellResult {
  parts: SellPart[];
  pu: number;
  q: number;
  bruto: number;
  custo: number;
  cust: number;
  iof: number;
  ir: number;
  irApp: number;
  liqReal: number;
  liqApp: number;
}

export interface RatePoint {
  month: number;
  label: string;
  ratePct: number;
}

export interface SensitivityRow {
  shock: number;
  newRate: number;
  newPU: number;
  bruto: number;
  brutoDiff: number;
  liqApp: number;
  liqDiff: number;
  puVarPct: number;
  liqReturnPct: number;
}

export interface IRScheduleInfo {
  rate: number;
  nextRate: number | null;
  daysRemaining: number;
  label: string;
  statusText: string;
}

export interface CarryMtMDecomposition {
  ganhoBrutoTotal: number;
  ganhoCarrego: number;
  ganhoMarcacao: number;
  pctCarrego: number;
  pctMarcacao: number;
}
