import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { RendaFixaStore } from './renda-fixa.store';
import { RendaFixaApiService } from '../../../core/services/renda-fixa-api.service';
import golden from '../../../core/financial-engine/__fixtures__/golden-renda-mais.json';
import { LotesRendaFixaResponse } from '../../../core/models/renda-fixa.models';

describe('RendaFixaStore', () => {
  let store: RendaFixaStore;
  let httpMock: HttpTestingController;

  const fakeAtivo = {
    id: 1,
    ticker: 'TD-RENDA+-2065',
    nome: 'Tesouro RendA+ 2065',
    tipo: 'RendaFixa' as any,
    detalhes_rf: {
      ativo_id: 1,
      produto: 'TESOURO_RENDA_MAIS' as const,
      indexador: 'IPCA' as const,
      emissor: 'Tesouro Nacional',
      ano_conversao: 2065,
      num_parcelas: 240,
      dia_pagamento: 15,
      isento_ir: false,
      cobra_custodia_b3: true,
    },
  };

  const fakeLotesResp: LotesRendaFixaResponse = {
    carteira_id: 1,
    gerado_em: '2026-10-05T00:00:00Z',
    posicoes: [
      {
        ativo: fakeAtivo,
        lotes: [
          {
            transacao_id: 1,
            data_compra: '2026-01-23',
            taxa_contratada: '6.99',
            preco_unitario: '185.02',
            quantidade_original: '25.35',
            quantidade_aberta: '25.35',
            custo_aberto_brl: '4690.26',
            custo_conhecido: true,
          },
          {
            transacao_id: 2,
            data_compra: '2026-03-24',
            taxa_contratada: '7.14',
            preco_unitario: '177.03',
            quantidade_original: '56.48',
            quantidade_aberta: '56.48',
            custo_aberto_brl: '9998.65',
            custo_conhecido: true,
          },
          {
            transacao_id: 3,
            data_compra: '2026-06-08',
            taxa_contratada: '7.27',
            preco_unitario: '172.89',
            quantidade_original: '28.92',
            quantidade_aberta: '28.92',
            custo_aberto_brl: '4999.98',
            custo_conhecido: true,
          },
          {
            transacao_id: 4,
            data_compra: '2026-07-30',
            taxa_contratada: '7.37',
            preco_unitario: '168.02',
            quantidade_original: '29.58',
            quantidade_aberta: '29.58',
            custo_aberto_brl: '4970.03',
            custo_conhecido: true,
          },
        ],
        fluxos_recebidos: [],
        quantidade_total: '140.33',
        custo_total_brl: '24658.92',
        pendencias: [],
      },
    ],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        RendaFixaStore,
        RendaFixaApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    store = TestBed.inject(RendaFixaStore);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('deve carregar ativos e lotes, e calcular vendaHoje() com paridade ao golden master', async () => {
    // Configura premissas com calibração idêntica ao golden fixture
    store.patchPremissas({
      refDate: '2026-10-05',
      refPrice: 243.38,
      refRate: '',
      ipcaCal: 4.5,
      ipcaProj: 4.5,
      custody: { custMode: 'single', cust1: 0.5 },
    });

    const carregarPromise = store.carregar();

    // 1. GET /api/v1/renda-fixa/ativos
    const reqAtivos = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos');
    expect(reqAtivos.request.method).toBe('GET');
    reqAtivos.flush([fakeAtivo]);
    await Promise.resolve();

    // 2. GET /api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=1
    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=1');
    expect(reqLotes.request.method).toBe('GET');
    reqLotes.flush(fakeLotesResp);
    await Promise.resolve();

    // 3. GET /api/v1/renda-fixa/mercado/tesouro?forcar=false
    const reqTesouro = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/mercado/tesouro?forcar=false');
    reqTesouro.flush({
      fonte: 'cache',
      obtido_em: '2026-10-05T12:00:00Z',
      cache_hit: true,
      stale: false,
      dados: { data_referencia: '2026-10-05', cotacoes: [] },
    });

    // 4. GET /api/v1/renda-fixa/mercado/macro?forcar=false
    const reqMacro = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/mercado/macro?forcar=false');
    reqMacro.flush({
      obtido_em: '2026-10-05T12:00:00Z',
      ipca_12m: { codigo: 433, nome: 'IPCA', ultima_data: '01/09/2026', valor_bruto: '0.44', valor_anualizado_pct: '4.50' },
      selic: { codigo: 11, nome: 'Selic', ultima_data: '05/10/2026', valor_bruto: '0.04', valor_anualizado_pct: '10.75' },
      cdi: { codigo: 12, nome: 'CDI', ultima_data: '05/10/2026', valor_bruto: '0.04', valor_anualizado_pct: '10.65' },
    });

    await carregarPromise;

    expect(store.lots().length).toBe(4);
    expect(store.pendencias().length).toBe(0);

    // Verificação de Paridade com Golden Master
    const vHoje = store.vendaHoje();
    expect(vHoje.bruto).toBe(golden.portfolio.sellHojeTotal.bruto);
    expect(vHoje.custo).toBe(golden.portfolio.sellHojeTotal.custo);
    expect(vHoje.cust).toBe(golden.portfolio.sellHojeTotal.cust);
    expect(vHoje.iof).toBe(golden.portfolio.sellHojeTotal.iof);
    expect(vHoje.ir).toBe(golden.portfolio.sellHojeTotal.ir);
    expect(vHoje.irApp).toBe(golden.portfolio.sellHojeTotal.irApp);
    expect(vHoje.liqReal).toBe(golden.portfolio.sellHojeTotal.liqReal);
    expect(vHoje.liqApp).toBe(golden.portfolio.sellHojeTotal.liqApp);
  });

  it('alterar sim.targetRatePct recalcula apenas derivados da simulação sem afetar vendaHoje()', async () => {
    store.posicao.set(fakeLotesResp.posicoes[0]);
    store.patchPremissas({
      refDate: '2026-10-05',
      refPrice: 243.38,
      refRate: '',
      ipcaCal: 4.5,
      ipcaProj: 4.5,
      custody: { custMode: 'single', cust1: 0.5 },
    });

    const vHojeAntes = store.vendaHoje();
    const rateAtSaleAntes = store.rateAtSale();
    const vSimAntes = store.vendaSim();

    // Altera apenas o slider de taxa alvo
    store.patchSim({ targetRatePct: 8.5 });

    const vHojeDepois = store.vendaHoje();
    const rateAtSaleDepois = store.rateAtSale();
    const vSimDepois = store.vendaSim();

    // vendaHoje() permanece exatamente inalterada
    expect(vHojeDepois.liqReal).toBe(vHojeAntes.liqReal);
    expect(vHojeDepois.liqApp).toBe(vHojeAntes.liqApp);

    // Derivados de simulação foram devidamente recalculados
    expect(rateAtSaleDepois).not.toBe(rateAtSaleAntes);
    expect(vSimDepois.liqReal).not.toBe(vSimAntes.liqReal);
  });

  it('alocacaoLotes deve numerar os lotes em ordem de aquisição (Lote 1 para o mais antigo)', () => {
    store.posicao.set(fakeLotesResp.posicoes[0]);
    const slices = store.alocacaoLotes();

    expect(slices.length).toBe(4);
    expect(slices[0].label).toContain('Lote 1 (2026-01-23)');
    expect(slices[1].label).toContain('Lote 2 (2026-03-24)');
    expect(slices[2].label).toContain('Lote 3 (2026-06-08)');
    expect(slices[3].label).toContain('Lote 4 (2026-07-30)');
  });

  it('simDN respeita simDN direto quando fornecido na simulação', () => {
    store.posicao.set(fakeLotesResp.posicoes[0]);
    store.patchPremissas({ refDate: '2026-10-05', refPrice: 243.38, ipcaCal: 4.5 });

    const targetDN = 21000;
    store.patchSim({ simDN: targetDN });

    expect(store.simDNClamped()).toBe(targetDN);
  });
});
