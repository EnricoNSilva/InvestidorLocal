import { parseNumber } from '../../../core/financial-engine/schema';
import { Premissas } from '../../../core/models/renda-fixa.models';

export const PREMISSAS_STORAGE_KEY = 'il.rendafixa.premissas.v1';

export const DEFAULT_PREMISSAS: Premissas = {
  selectedBond: 'tesouro-renda-mais-2065',
  refDate: '2026-10-05',
  refPrice: 243.38,
  refRate: '',
  spread: 0.0,
  ipcaCal: 4.5,
  ipcaProj: 4.5,
  cdiRatePct: 10.75,
  custody: {
    custMode: 'single',
    cust1: 0.5,
    cust2: 0.2,
    cust3: 0.1,
  },
};

export function sanitizePremissas(raw: Partial<Premissas> = {}): Premissas {
  const custodyRaw = raw.custody || {};
  const custMode = (
    ['single', 'marginal', 'none'].includes(custodyRaw.custMode as string)
      ? custodyRaw.custMode
      : 'single'
  ) as 'single' | 'marginal' | 'none';

  return {
    selectedBond: String(raw.selectedBond || DEFAULT_PREMISSAS.selectedBond).trim(),
    refDate: String(raw.refDate || DEFAULT_PREMISSAS.refDate).trim(),
    refPrice: Math.max(0.01, parseNumber(raw.refPrice, DEFAULT_PREMISSAS.refPrice)),
    refRate:
      raw.refRate === '' || raw.refRate === null || raw.refRate === undefined
        ? ''
        : parseNumber(raw.refRate, ''),
    spread: Math.max(0, parseNumber(raw.spread, 0)),
    ipcaCal: parseNumber(raw.ipcaCal, DEFAULT_PREMISSAS.ipcaCal),
    ipcaProj: parseNumber(raw.ipcaProj, DEFAULT_PREMISSAS.ipcaProj),
    cdiRatePct: parseNumber(raw.cdiRatePct, DEFAULT_PREMISSAS.cdiRatePct),
    custody: {
      custMode,
      cust1: Math.max(0, parseNumber(custodyRaw.cust1, 0.5)),
      cust2: Math.max(0, parseNumber(custodyRaw.cust2, 0.2)),
      cust3: Math.max(0, parseNumber(custodyRaw.cust3, 0.1)),
    },
  };
}

export function loadPremissas(): Premissas {
  try {
    const raw = localStorage.getItem(PREMISSAS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return sanitizePremissas(parsed);
    }
  } catch (e) {
    console.warn('Erro ao carregar premissas do localStorage:', e);
  }
  return { ...DEFAULT_PREMISSAS };
}

export function savePremissas(p: Premissas): void {
  try {
    localStorage.setItem(PREMISSAS_STORAGE_KEY, JSON.stringify(p));
  } catch (e) {
    console.warn('Erro ao salvar premissas no localStorage:', e);
  }
}
