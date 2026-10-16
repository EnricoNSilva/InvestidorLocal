import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { RendaFixaStore } from './renda-fixa.store';
import { RendaFixaApiService } from '../../../core/services/renda-fixa-api.service';
import golden from '../../../core/financial-engine/__fixtures__/golden-renda-mais.json';
import { LotesRendaFixaResponse } from '../../../core/models/renda-fixa.models';
import { calcXIRR } from '../../../core/financial-engine/metrics';
import { toDayNum } from '../../../core/financial-engine/dates';
import { trunc2 } from '../../../core/financial-engine/bond';

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

  it('posTIR e simTIR devem ignorar fluxos de SELL e posTIR deve utilizar liqReal', () => {
    store.patchPremissas({
      refDate: '2026-10-05',
      refPrice: 243.38,
      refRate: '',
      ipcaCal: 4.5,
      ipcaProj: 4.5,
      custody: { custMode: 'single', cust1: 0.5 },
    });

    const posSemSell = JSON.parse(JSON.stringify(fakeLotesResp.posicoes[0]));
    posSemSell.fluxos_recebidos = [
      {
        transacao_id: 99,
        data: '2026-05-01',
        tipo: 'JUROS_CUPOM',
        valor_brl: '100.00',
      },
    ];

    store.posicao.set(posSemSell);
    const tirSemSell = store.posTIR();
    const simTirSemSell = store.simTIR();

    // Adiciona fluxo de SELL
    const posComSell = JSON.parse(JSON.stringify(posSemSell));
    posComSell.fluxos_recebidos.push({
      transacao_id: 100,
      data: '2026-06-01',
      tipo: 'SELL',
      valor_brl: '5000.00',
    });

    store.posicao.set(posComSell);
    const tirComSell = store.posTIR();
    const simTirComSell = store.simTIR();

    // O fluxo SELL deve ser ignorado: posTIR e simTIR devem ser exatamente iguais aos sem SELL
    expect(tirComSell).toBe(tirSemSell);
    expect(simTirComSell).toBe(simTirSemSell);

    // Validação matemática estrita de que posTIR utiliza liqReal e não liqApp
    const defaultLots = store.lots();
    const flowsReal = [
      ...defaultLots.map((l) => ({
        dn: typeof l.dn === 'number' ? l.dn : toDayNum(l.date),
        amount: -trunc2(l.qty * l.price),
      })),
      { dn: toDayNum('2026-05-01'), amount: 100 },
      { dn: store.calib().refDN, amount: store.vendaHoje().liqReal },
    ];
    const expectedTirReal = calcXIRR(flowsReal);

    const flowsApp = [
      ...defaultLots.map((l) => ({
        dn: typeof l.dn === 'number' ? l.dn : toDayNum(l.date),
        amount: -trunc2(l.qty * l.price),
      })),
      { dn: toDayNum('2026-05-01'), amount: 100 },
      { dn: store.calib().refDN, amount: store.vendaHoje().liqApp },
    ];
    const expectedTirApp = calcXIRR(flowsApp);

    expect(store.vendaHoje().liqReal).not.toBe(store.vendaHoje().liqApp);
    expect(store.vendaHoje().liqReal).toBeLessThan(store.vendaHoje().liqApp);
    expect(tirComSell).toBe(expectedTirReal);
    expect(tirComSell).not.toBe(expectedTirApp);
    expect(Math.abs(tirComSell - expectedTirReal)).toBeLessThanOrEqual(1e-12);
  });

  it('selecionarAtivo reseta qtyToSell, limpa erro e descarta respostas assíncronas concorrentes', async () => {
    store.patchSim({ qtyToSell: 50 });
    store.error.set('Erro residual anterior');
    expect(store.sim().qtyToSell).toBe(50);
    expect(store.error()).toBe('Erro residual anterior');

    const fakePosicao1: LotesRendaFixaResponse = {
      carteira_id: 1,
      gerado_em: '2026-10-05T00:00:00Z',
      posicoes: [{ ...fakeLotesResp.posicoes[0], ativo: { ...fakeAtivo, id: 1, ticker: 'ATIVO-1' } }],
    };

    const fakePosicao2: LotesRendaFixaResponse = {
      carteira_id: 1,
      gerado_em: '2026-10-05T00:00:00Z',
      posicoes: [{ ...fakeLotesResp.posicoes[0], ativo: { ...fakeAtivo, id: 2, ticker: 'ATIVO-2' } }],
    };

    // 1. Dispara selecionarAtivo(1)
    const p1 = store.selecionarAtivo(1);
    expect(store.sim().qtyToSell).toBe('');
    expect(store.error()).toBeNull();
    expect(store.loading()).toBeTrue();

    // 2. Dispara selecionarAtivo(2) antes de 1 responder
    store.patchSim({ qtyToSell: 30 });
    const p2 = store.selecionarAtivo(2);
    expect(store.sim().qtyToSell).toBe('');
    expect(store.loading()).toBeTrue();

    const req1 = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=1');
    const req2 = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=2');

    // 3. Resposta de 1 chega DEPOIS de 2 ter sido disparado
    req1.flush(fakePosicao1);
    await p1;

    // A posição NÃO deve ter sido sobrescrita por fakePosicao1 e loading deve continuar true pois p2 está pendente
    expect(store.posicao()).toBeNull();
    expect(store.loading()).toBeTrue();

    // 4. Resposta de 2 chega
    req2.flush(fakePosicao2);
    await p2;

    expect(store.posicao()?.ativo.ticker).toBe('ATIVO-2');
    expect(store.loading()).toBeFalse();
    expect(store.error()).toBeNull();
  });

  it('selecionarAtivo: erro em requisição obsoleta não deve sobrescrever erro nem loading', async () => {
    const fakePosicao2: LotesRendaFixaResponse = {
      carteira_id: 1,
      gerado_em: '2026-10-05T00:00:00Z',
      posicoes: [{ ...fakeLotesResp.posicoes[0], ativo: { ...fakeAtivo, id: 2, ticker: 'ATIVO-2' } }],
    };

    const p1 = store.selecionarAtivo(1);
    const p2 = store.selecionarAtivo(2);

    const req1 = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=1');
    const req2 = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=2');

    // req1 falha com 500
    req1.flush('Server Error', { status: 500, statusText: 'Internal Server Error' });
    await p1;

    // req1 era obsoleto, então error deve permanecer nulo e loading true
    expect(store.error()).toBeNull();
    expect(store.loading()).toBeTrue();

    // req2 tem sucesso
    req2.flush(fakePosicao2);
    await p2;

    expect(store.error()).toBeNull();
    expect(store.loading()).toBeFalse();
    expect(store.posicao()?.ativo.ticker).toBe('ATIVO-2');
  });

  it('selecionarAtivo: resposta de requisição anterior que chega após a requisição mais recente ter finalizado não deve sobrescrever a posição', async () => {
    const fakePosicao1: LotesRendaFixaResponse = {
      carteira_id: 1,
      gerado_em: '2026-10-05T00:00:00Z',
      posicoes: [{ ...fakeLotesResp.posicoes[0], ativo: { ...fakeAtivo, id: 1, ticker: 'ATIVO-1' } }],
    };

    const fakePosicao2: LotesRendaFixaResponse = {
      carteira_id: 1,
      gerado_em: '2026-10-05T00:00:00Z',
      posicoes: [{ ...fakeLotesResp.posicoes[0], ativo: { ...fakeAtivo, id: 2, ticker: 'ATIVO-2' } }],
    };

    const p1 = store.selecionarAtivo(1);
    const p2 = store.selecionarAtivo(2);

    const req1 = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=1');
    const req2 = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=2');

    // Resposta 2 chega primeiro e tem sucesso
    req2.flush(fakePosicao2);
    await p2;

    expect(store.posicao()?.ativo.ticker).toBe('ATIVO-2');
    expect(store.loading()).toBeFalse();

    // Resposta 1 (antiga) chega atrasada depois que 2 já completou
    req1.flush(fakePosicao1);
    await p1;

    // A posição continua sendo ATIVO-2 e loading continua false
    expect(store.posicao()?.ativo.ticker).toBe('ATIVO-2');
    expect(store.loading()).toBeFalse();
  });

  it('salvarTaxa: recarga defasada não deve sobrescrever ativo selecionado posteriormente', async () => {
    const fakePosicao1: LotesRendaFixaResponse = {
      carteira_id: 1,
      gerado_em: '2026-10-05T00:00:00Z',
      posicoes: [{ ...fakeLotesResp.posicoes[0], ativo: { ...fakeAtivo, id: 1, ticker: 'ATIVO-1' } }],
    };
    const fakePosicao2: LotesRendaFixaResponse = {
      carteira_id: 1,
      gerado_em: '2026-10-05T00:00:00Z',
      posicoes: [{ ...fakeLotesResp.posicoes[0], ativo: { ...fakeAtivo, id: 2, ticker: 'ATIVO-2' } }],
    };

    store.posicao.set(fakePosicao1.posicoes[0]);
    store.ativoId.set(1);

    // Inicia salvarTaxa
    const pTaxa = store.salvarTaxa(1, 7.5);
    expect(store.loading()).toBeTrue();

    // Usuário troca de ativo antes de salvarTaxa terminar
    const pSel = store.selecionarAtivo(2);

    const reqPatch = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/transacoes/1/taxa');
    const reqSel = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=2');

    // Sucesso no patch de salvarTaxa
    reqPatch.flush({ id: 1, taxa_contratada: '7.5000' });
    // Resposta de selecionarAtivo chega
    reqSel.flush(fakePosicao2);
    await pSel;

    expect(store.posicao()?.ativo.ticker).toBe('ATIVO-2');
    expect(store.loading()).toBeFalse();

    await pTaxa;
    // Posição deve permanecer do ativo recém-selecionado (ATIVO-2)
    expect(store.posicao()?.ativo.ticker).toBe('ATIVO-2');
  });
});

