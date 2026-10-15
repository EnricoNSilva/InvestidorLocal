/**
 * Camada de Integração com APIs Externas (BCB e brapi.dev)
 * Suporte a dados macroeconômicos e cotações de títulos do Tesouro Direto
 * com fallbacks e normalização de dados.
 */

import { parseNumber } from './schema';

export interface TreasuryBondQuote {
  symbol: string;
  name: string;
  bondType: string;
  indexer: string;
  sellRate: number;
  buyRate: number;
  sellPrice: number;
  buyPrice: number;
  baseDate: string;
}

export const DEFAULT_TREASURY_BONDS: TreasuryBondQuote[] = [
  {
    symbol: 'tesouro-renda-mais-2065',
    name: 'Tesouro Renda+ 2065 (NTN-B1)',
    bondType: 'Tesouro Renda+',
    indexer: 'ipca',
    sellRate: 6.55,
    buyRate: 6.55,
    sellPrice: 243.38,
    buyPrice: 243.38,
    baseDate: '2026-10-05',
  },
  {
    symbol: 'tesouro-ipca-2029',
    name: 'Tesouro IPCA+ 2029',
    bondType: 'Tesouro IPCA+',
    indexer: 'ipca',
    sellRate: 6.62,
    buyRate: 6.5,
    sellPrice: 3410.5,
    buyPrice: 3425.1,
    baseDate: '2026-10-06',
  },
  {
    symbol: 'tesouro-ipca-2035',
    name: 'Tesouro IPCA+ 2035',
    bondType: 'Tesouro IPCA+',
    indexer: 'ipca',
    sellRate: 6.68,
    buyRate: 6.56,
    sellPrice: 2450.2,
    buyPrice: 2468.9,
    baseDate: '2026-10-06',
  },
  {
    symbol: 'tesouro-ipca-2045',
    name: 'Tesouro IPCA+ 2045',
    bondType: 'Tesouro IPCA+',
    indexer: 'ipca',
    sellRate: 6.75,
    buyRate: 6.63,
    sellPrice: 1320.15,
    buyPrice: 1335.4,
    baseDate: '2026-10-06',
  },
  {
    symbol: 'tesouro-selic-2029',
    name: 'Tesouro Selic 2029',
    bondType: 'Tesouro Selic',
    indexer: 'selic',
    sellRate: 0.05,
    buyRate: 0.04,
    sellPrice: 15600.0,
    buyPrice: 15615.0,
    baseDate: '2026-10-06',
  },
  {
    symbol: 'tesouro-selic-01032031',
    name: 'Tesouro Selic 2031',
    bondType: 'Tesouro Selic',
    indexer: 'selic',
    sellRate: 0.1,
    buyRate: 0.09,
    sellPrice: 19943.27,
    buyPrice: 19962.22,
    baseDate: '2026-10-06',
  },
  {
    symbol: 'tesouro-prefixado-2027',
    name: 'Tesouro Prefixado 2027',
    bondType: 'Tesouro Prefixado',
    indexer: 'prefixado',
    sellRate: 12.85,
    buyRate: 12.7,
    sellPrice: 785.4,
    buyPrice: 790.1,
    baseDate: '2026-10-06',
  },
  {
    symbol: 'tesouro-prefixado-2031',
    name: 'Tesouro Prefixado 2031',
    bondType: 'Tesouro Prefixado',
    indexer: 'prefixado',
    sellRate: 13.1,
    buyRate: 12.95,
    sellPrice: 510.2,
    buyPrice: 515.8,
    baseDate: '2026-10-06',
  },
];

/**
 * Converte valores da API (números ou strings com vírgula pt-BR) para Number seguro.
 */
function normalizeApiNumber(val: any, fallback = 0): number {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number') return isNaN(val) ? fallback : val;
  return parseNumber(val, fallback);
}

export interface MacroDataResult {
  success: boolean;
  ipca: number | null;
  selic: number | null;
}

/**
 * Busca dados macroeconômicos (IPCA e Selic) do SGS (BCB).
 */
export async function fetchMacroData(): Promise<MacroDataResult> {
  try {
    const ipcaRes = await fetch(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados/ultimos/12?formato=json'
    );
    if (!ipcaRes.ok) throw new Error('Falha ao buscar IPCA no BCB');
    const ipcaData = await ipcaRes.json();

    let ipcaAccumulated = 1;
    for (const item of ipcaData) {
      const valor = parseFloat(item.valor) / 100;
      ipcaAccumulated *= 1 + valor;
    }
    const ipcaAnual = (ipcaAccumulated - 1) * 100;

    const selicRes = await fetch(
      'https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/1?formato=json'
    );
    let selicAtual: number | null = null;
    if (selicRes.ok) {
      const selicData = await selicRes.json();
      if (selicData.length > 0) {
        const rawValor = parseFloat(selicData[0].valor);
        if (rawValor > 0 && rawValor < 1) {
          // Série 11 do SGS retorna taxa diária (% a.d.). Anualização composta base 252 dias úteis.
          const selicAnual = (Math.pow(1 + rawValor / 100, 252) - 1) * 100;
          selicAtual = Number(selicAnual.toFixed(2));
        } else {
          selicAtual = Number(rawValor.toFixed(2));
        }
      }
    }

    return {
      success: true,
      ipca: Number(ipcaAnual.toFixed(2)),
      selic: selicAtual,
    };
  } catch (error) {
    console.error('[API] Falha ao buscar dados macroeconômicos:', error);
    return { success: false, ipca: null, selic: null };
  }
}

export interface TreasuryDataResult {
  success: boolean;
  results: TreasuryBondQuote[];
  fetchMode: string;
  fromApi: boolean;
}

/**
 * Busca cotações de títulos do Tesouro Direto via brapi.dev com fallback elegante.
 */
export async function fetchTreasuryData(token = ''): Promise<TreasuryDataResult> {
  const mergedMap = new Map<string, TreasuryBondQuote>();
  DEFAULT_TREASURY_BONDS.forEach((b) => mergedMap.set(b.symbol, { ...b }));

  let fetchMode = 'fallback';

  // 1. Busca da nossa API Customizada (GitHub Pages)
  try {
    const ts = new Date().getTime();
    const res = await fetch(
      `https://enriconsilva.github.io/Marcacaoamercado/bonds.json?t=${ts}`
    );
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data?.results) ? data.results : [];
      if (list.length > 0) {
        list.forEach((item: any) => {
          const sym = item.symbol;
          if (!sym) return;
          mergedMap.set(sym, {
            symbol: sym,
            name: item.name,
            bondType: item.bondType,
            indexer: item.indexer,
            sellRate: normalizeApiNumber(item.sellRate, 0),
            buyRate: normalizeApiNumber(item.buyRate, 0),
            sellPrice: normalizeApiNumber(item.sellPrice, 0),
            buyPrice: normalizeApiNumber(item.buyPrice, 0),
            baseDate: item.baseDate,
          });
        });
        fetchMode = 'custom';
      }
    }
  } catch (err) {
    console.warn('[API] Erro ao buscar títulos na nossa API customizada:', err);
  }

  // 2. Se a API customizada falhar, tenta sandbox da brapi como último recurso
  if (fetchMode === 'fallback') {
    try {
      const sandboxRes = await fetch(
        'https://brapi.dev/api/v2/treasury/indicators?symbols=tesouro-selic-01032031'
      );
      if (sandboxRes.ok) {
        const data = await sandboxRes.json();
        if (Array.isArray(data?.results)) {
          data.results.forEach((item: any) => {
            const sym = item.symbol;
            if (sym && mergedMap.has(sym)) {
              const current = mergedMap.get(sym)!;
              mergedMap.set(sym, {
                ...current,
                sellRate: normalizeApiNumber(item.sellRate, current.sellRate),
                buyRate: normalizeApiNumber(item.buyRate, current.buyRate),
                sellPrice: normalizeApiNumber(item.sellPrice ?? item.basePrice, current.sellPrice),
                buyPrice: normalizeApiNumber(item.buyPrice, current.buyPrice),
                baseDate: item.baseDate || current.baseDate,
              });
            }
          });
          fetchMode = 'sandbox';
        }
      }
    } catch (err) {
      console.warn('[API] Sandbox brapi indisponível:', err);
    }
  }

  const results = Array.from(mergedMap.values());
  return {
    success: true,
    results,
    fetchMode,
    fromApi: fetchMode !== 'fallback',
  };
}

/**
 * Localiza dados de um título específico.
 */
export async function findBondData(
  symbolOrName: string,
  token = ''
): Promise<TreasuryBondQuote | null> {
  const { results } = await fetchTreasuryData(token);
  const target = String(symbolOrName || '')
    .toLowerCase()
    .trim();
  return (
    results.find(
      (b) => b.symbol.toLowerCase() === target || b.name.toLowerCase().includes(target)
    ) || null
  );
}
