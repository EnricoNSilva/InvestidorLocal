/**
 * Motor Financeiro - Módulo de Datas
 * Manipulação e conversão de datas sem dependência de fuso horário.
 */

import type { DayNum } from './types';

export const MS_DAY = 86400000;

/**
 * Converte data ISO ('AAAA-MM-DD') para número inteiro de dias desde o epoch UTC (1970-01-01).
 * Evita bugs de timezone local (meia-noite local virando dia anterior em UTC).
 */
export function toDayNum(iso: string | null | undefined): DayNum {
  if (!iso) return NaN;
  const parts = String(iso).split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return NaN;
  const [y, m, d] = parts;
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

/**
 * Converte número de dias UTC em string ISO 'AAAA-MM-DD'.
 */
export function dayNumToIso(dn: DayNum): string {
  if (isNaN(dn)) return '';
  return new Date(dn * MS_DAY).toISOString().slice(0, 10);
}

/**
 * Formata número de dias UTC em string pt-BR 'DD/MM/AAAA'.
 */
export function formatBRLDate(dn: DayNum): string {
  if (isNaN(dn)) return '';
  const d = new Date(dn * MS_DAY);
  return (
    String(d.getUTCDate()).padStart(2, '0') +
    '/' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '/' +
    d.getUTCFullYear()
  );
}

/**
 * Adiciona meses a uma data (dia número), mantendo o dia se possível.
 */
export function addMonthsDN(dn: DayNum, months: number): DayNum {
  const d = new Date(dn * MS_DAY);
  return Math.round(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()) / MS_DAY
  );
}

/**
 * Adiciona anos (com frações) a uma data.
 */
export function addYearsDN(dn: DayNum, years: number): DayNum {
  return addMonthsDN(dn, Math.round(years * 12));
}

/**
 * Diferença em dias corridos entre duas datas.
 */
export function diffDays(dnA: DayNum, dnB: DayNum): number {
  return dnB - dnA;
}

/**
 * Diferença aproximada em anos corridos.
 */
export function diffYears(dnA: DayNum, dnB: DayNum): number {
  return (dnB - dnA) / 365.25;
}
