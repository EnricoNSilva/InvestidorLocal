import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { RendaFixaStore } from './renda-fixa.store';
import { RendaFixaApiService } from '../../../core/services/renda-fixa-api.service';
import golden from '../../../core/financial-engine/__fixtures__/golden-renda-mais.json';
import {
  AtivoRendaFixa,
  LotesRendaFixaResponse,
  PosicaoRendaFixa,
} from '../../../core/models/renda-fixa.models';
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
    localStorage.clear();
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
    localStorage.clear();
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

  it('deve adaptar o motor ao selecionar LCI 95% CDI (ir === 0, cust === 0, ganhoMarcacao === 0)', () => {
    const fakeLciAtivo: AtivoRendaFixa = {
      id: 10,
      ticker: 'LCI-DAYCOVAL-2028',
      nome: 'LCI Banco Daycoval 95% CDI',
      tipo: 'RendaFixa',
      setor: 'Renda Fixa',
      detalhes_rf: {
        ativo_id: 10,
        produto: 'LCI',
        indexador: 'CDI',
        emissor: 'Banco Daycoval',
        percentual_indexador: 95,
        data_vencimento: '2028-10-15',
        isento_ir: true,
        cobra_custodia_b3: false,
      },
    };

    const fakeLciPos: PosicaoRendaFixa = {
      ativo: fakeLciAtivo,
      lotes: [
        {
          transacao_id: 101,
          data_compra: '2026-01-15',
          taxa_contratada: '95.0',
          preco_unitario: '1000.00',
          quantidade_original: '10',
          quantidade_aberta: '10',
          custo_aberto_brl: '10000.00',
          custo_conhecido: true,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '10',
      custo_total_brl: '10000.00',
      pendencias: [],
    };

    store.posicao.set(fakeLciPos);
    store.ativoId.set(10);
    store.patchPremissas({
      refDate: '2026-10-15',
      cdiRatePct: 10.65,
    });

    const inst = store.instrument();
    expect(inst.kind).toBe('CDI_POS');
    expect(inst.supportsMtM).toBeFalse();

    const venda = store.vendaHoje();
    expect(venda.bruto).toBeGreaterThan(10000);
    expect(venda.ir).toBe(0);
    expect(venda.cust).toBe(0);
    expect(venda.liqReal).toBe(venda.bruto);
    expect(venda.liqApp).toBe(venda.bruto);

    const decomp = store.decomposicao();
    expect(decomp.ganhoMarcacao).toBe(0);
    expect(decomp.pctCarrego).toBe(1);
    expect(decomp.pctMarcacao).toBe(0);
  });

  it('criarTituloManual: deve invocar endpoint de cadastro e atualizar estado', async () => {
    const fakeNovoAtivo: AtivoRendaFixa = {
      id: 20,
      ticker: 'CDB-INTER-2028',
      nome: 'CDB Banco Inter 110% CDI',
      tipo: 'RendaFixa',
      setor: 'Renda Fixa',
      detalhes_rf: {
        ativo_id: 20,
        produto: 'CDB',
        indexador: 'CDI',
        emissor: 'Banco Inter',
        percentual_indexador: 110,
        data_vencimento: '2028-10-15',
        isento_ir: false,
        cobra_custodia_b3: false,
      },
    };

    const fakeNovaPos: PosicaoRendaFixa = {
      ativo: fakeNovoAtivo,
      lotes: [
        {
          transacao_id: 201,
          data_compra: '2026-10-15',
          taxa_contratada: '110.0',
          preco_unitario: '1000.00',
          quantidade_original: '5',
          quantidade_aberta: '5',
          custo_aberto_brl: '5000.00',
          custo_conhecido: true,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '5',
      custo_total_brl: '5000.00',
      pendencias: [],
    };

    const p = store.criarTituloManual({
      nome: 'CDB Banco Inter 110% CDI',
      detalhes: {
        produto: 'CDB',
        indexador: 'CDI',
        emissor: 'Banco Inter',
        percentual_indexador: 110,
        isento_ir: false,
        cobra_custodia_b3: false,
      },
      lote_inicial: {
        carteira_id: 1,
        data_compra: '2026-10-15',
        quantidade: 5,
        preco_unitario: 1000,
        taxa_contratada: 110,
      },
    });

    const reqPost = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/cadastro-manual');
    expect(reqPost.request.method).toBe('POST');
    reqPost.flush(fakeNovaPos);
    await Promise.resolve();

    const reqAtivos = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos');
    reqAtivos.flush([fakeNovoAtivo]);

    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
    reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-15T00:00:00Z', posicoes: [fakeNovaPos] });

    const res = await p;
    expect(res.ativo.ticker).toBe('CDB-INTER-2028');
    expect(store.ativoId()).toBe(20);
    expect(store.posicao()?.ativo.ticker).toBe('CDB-INTER-2028');
    expect(store.instrument().kind).toBe('CDI_POS');
  });

  it('adicionarLote: deve invocar endpoint de novo lote e atualizar posicao', async () => {
    const fakePosAtualizada: PosicaoRendaFixa = {
      ativo: fakeAtivo,
      lotes: [
        ...fakeLotesResp.posicoes[0].lotes,
        {
          transacao_id: 999,
          data_compra: '2026-10-15',
          taxa_contratada: '7.5',
          preco_unitario: '200.00',
          quantidade_original: '10',
          quantidade_aberta: '10',
          custo_aberto_brl: '2000.00',
          custo_conhecido: true,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '150.33',
      custo_total_brl: '26658.92',
      pendencias: [],
    };

    store.posicao.set(fakeLotesResp.posicoes[0]);
    store.ativoId.set(1);

    const p = store.adicionarLote(1, {
      carteira_id: 1,
      data_compra: '2026-10-15',
      quantidade: 10,
      preco_unitario: 200,
      taxa_contratada: 7.5,
    });

    const reqPost = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos/1/lotes');
    expect(reqPost.request.method).toBe('POST');
    reqPost.flush(fakePosAtualizada);
    await Promise.resolve();

    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
    reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-15T00:00:00Z', posicoes: [fakePosAtualizada] });

    const res = await p;
    expect(res.lotes.length).toBe(fakeLotesResp.posicoes[0].lotes.length + 1);
    expect(store.posicao()?.lotes.length).toBe(fakeLotesResp.posicoes[0].lotes.length + 1);
  });

  it('effectiveRefDN deve incluir lote recém-comprado quando data_compra > premissas.refDate', () => {
    const fakeCdbAtivo: AtivoRendaFixa = {
      id: 30,
      ticker: 'CDB-RECEM-COMPRADO',
      nome: 'CDB Recém Comprado 110% CDI',
      tipo: 'RendaFixa',
      setor: 'Renda Fixa',
      detalhes_rf: {
        ativo_id: 30,
        produto: 'CDB',
        indexador: 'CDI',
        emissor: 'Banco Inter',
        percentual_indexador: 110,
        data_vencimento: '2029-10-15',
        isento_ir: false,
        cobra_custodia_b3: false,
      },
    };

    // Premissa refDate está no dia anterior (ex: snapshot do último pregão 2026-10-14)
    // enquanto o lote foi cadastrado em 2026-10-16
    store.patchPremissas({
      refDate: '2026-10-14',
      cdiRatePct: 10.65,
    });

    store.posicao.set({
      ativo: fakeCdbAtivo,
      lotes: [
        {
          transacao_id: 301,
          data_compra: '2026-10-16',
          taxa_contratada: '110.0',
          preco_unitario: '1000.00',
          quantidade_original: '3',
          quantidade_aberta: '3',
          custo_aberto_brl: '3000.00',
          custo_conhecido: true,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '3',
      custo_total_brl: '3000.00',
      pendencias: [],
    });

    expect(store.effectiveRefDN()).toBe(toDayNum('2026-10-16'));
    const venda = store.vendaHoje();
    expect(venda.q).toBe(3);
    expect(venda.bruto).toBe(3000);
    expect(venda.liqReal).toBe(3000);
  });

  it('sensibilidade deve responder a choques para TESOURO_SELIC (SELIC_POS) e TESOURO_PREFIXADO (PREFIXADO com MtM)', () => {
    // 1. TESOURO_SELIC
    const selicAtivo: AtivoRendaFixa = {
      id: 40,
      ticker: 'LFT-2029',
      nome: 'Tesouro Selic 2029',
      tipo: 'RendaFixa',
      setor: 'Renda Fixa',
      detalhes_rf: {
        ativo_id: 40,
        produto: 'TESOURO_SELIC',
        indexador: 'SELIC',
        emissor: 'Tesouro Nacional',
        data_vencimento: '2029-03-01',
        isento_ir: false,
        cobra_custodia_b3: true,
      },
    };

    store.patchPremissas({
      refDate: '2026-10-15',
      cdiRatePct: 10.75,
    });

    store.posicao.set({
      ativo: selicAtivo,
      lotes: [
        {
          transacao_id: 401,
          data_compra: '2026-01-15',
          taxa_contratada: '0.05',
          preco_unitario: '14000.00',
          quantidade_original: '1',
          quantidade_aberta: '1',
          custo_aberto_brl: '14000.00',
          custo_conhecido: true,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '1',
      custo_total_brl: '14000.00',
      pendencias: [],
    });

    const rowsSelic = store.sensibilidade();
    expect(rowsSelic.length).toBe(8);
    // Choques negativos na Selic devem reduzir o bruto no vencimento; choques positivos devem aumentar
    expect(rowsSelic[0].brutoDiff).toBeLessThan(0);
    expect(rowsSelic[rowsSelic.length - 1].brutoDiff).toBeGreaterThan(0);

    // 2. TESOURO_PREFIXADO (Bullet com MtM)
    const preAtivo: AtivoRendaFixa = {
      id: 41,
      ticker: 'LTN-2029',
      nome: 'Tesouro Prefixado 2029',
      tipo: 'RendaFixa',
      setor: 'Renda Fixa',
      detalhes_rf: {
        ativo_id: 41,
        produto: 'TESOURO_PREFIXADO',
        indexador: 'PREFIXADO',
        emissor: 'Tesouro Nacional',
        data_vencimento: '2029-01-01',
        isento_ir: false,
        cobra_custodia_b3: true,
      },
    };

    store.posicao.set({
      ativo: preAtivo,
      lotes: [
        {
          transacao_id: 402,
          data_compra: '2026-01-15',
          taxa_contratada: '12.50',
          preco_unitario: '750.00',
          quantidade_original: '10',
          quantidade_aberta: '10',
          custo_aberto_brl: '7500.00',
          custo_conhecido: true,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '10',
      custo_total_brl: '7500.00',
      pendencias: [],
    });

    const rowsPre = store.sensibilidade();
    expect(rowsPre.length).toBe(8);
    // Na marcação a mercado de prefixado, queda na taxa de mercado (shock < 0) aumenta o PU hoje (brutoDiff > 0)
    expect(rowsPre[0].brutoDiff).toBeGreaterThan(0);
    expect(rowsPre[rowsPre.length - 1].brutoDiff).toBeLessThan(0);
  });

  it('atualizarTitulo: deve invocar PUT /ativos/{id}, recarregar ativos e lotes, e atualizar a posicao', async () => {
    const updatedAtivo: AtivoRendaFixa = {
      ...fakeAtivo,
      nome: 'Tesouro RendA+ 2065 Atualizado',
    };
    const updatedPos: PosicaoRendaFixa = {
      ...fakeLotesResp.posicoes[0],
      ativo: updatedAtivo,
    };

    store.posicao.set(fakeLotesResp.posicoes[0]);
    store.ativoId.set(1);

    const p = store.atualizarTitulo(1, {
      nome: 'Tesouro RendA+ 2065 Atualizado',
      detalhes: {
        produto: 'TESOURO_RENDA_MAIS',
        indexador: 'IPCA',
      },
    });

    const reqPut = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos/1?carteira_id=1');
    expect(reqPut.request.method).toBe('PUT');
    reqPut.flush(updatedPos);
    await Promise.resolve();

    const reqAtivos = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos');
    reqAtivos.flush([updatedAtivo]);

    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
    reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-05T00:00:00Z', posicoes: [updatedPos] });

    const res = await p;
    expect(res.ativo.nome).toBe('Tesouro RendA+ 2065 Atualizado');
    expect(store.posicao()?.ativo.nome).toBe('Tesouro RendA+ 2065 Atualizado');
  });

  it('excluirTitulo: deve invocar DELETE /ativos/{id}, recarregar e selecionar próximo ativo ou limpar se vazio', async () => {
    store.posicao.set(fakeLotesResp.posicoes[0]);
    store.ativoId.set(1);

    const p = store.excluirTitulo(1);

    const reqDel = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos/1');
    expect(reqDel.request.method).toBe('DELETE');
    reqDel.flush(null);
    await Promise.resolve();

    const reqAtivos = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos');
    reqAtivos.flush([]);

    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
    reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-05T00:00:00Z', posicoes: [] });

    await p;
    expect(store.ativos().length).toBe(0);
    expect(store.ativoId()).toBeNull();
    expect(store.posicao()).toBeNull();
  });

  it('excluirTitulo: deve preservar ativo selecionado caso o título excluído seja outro', async () => {
    const at1: AtivoRendaFixa = { id: 1, ticker: 'CDB-1', nome: 'CDB 1', tipo: 'RendaFixa' };
    const at2: AtivoRendaFixa = { id: 2, ticker: 'CDB-2', nome: 'CDB 2', tipo: 'RendaFixa' };
    const pos2: PosicaoRendaFixa = {
      ativo: at2,
      lotes: [],
      fluxos_recebidos: [],
      quantidade_total: '10',
      custo_total_brl: '1000',
      pendencias: [],
    };

    store.ativos.set([at1, at2]);
    store.ativoId.set(2);
    store.posicao.set(pos2);

    const p = store.excluirTitulo(1);

    const reqDel = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos/1');
    reqDel.flush(null);
    await Promise.resolve();

    const reqAtivos = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/ativos');
    reqAtivos.flush([at2]);

    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
    reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-05T00:00:00Z', posicoes: [pos2] });

    await p;
    expect(store.ativos().length).toBe(1);
    expect(store.ativoId()).toBe(2);
    expect(store.posicao()?.ativo.id).toBe(2);
  });

  it('editarLote: deve invocar PUT /lotes/{id}, atualizar posicao e recarregar todasPosicoes', async () => {
    const updatedPos: PosicaoRendaFixa = {
      ...fakeLotesResp.posicoes[0],
      quantidade_total: '145.00',
    };

    store.posicao.set(fakeLotesResp.posicoes[0]);

    const p = store.editarLote(1, {
      data_compra: '2026-01-25',
      quantidade: 30,
      preco_unitario: 190,
      taxa_contratada: 7.0,
      taxas: 0,
    });

    const reqPut = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes/1');
    expect(reqPut.request.method).toBe('PUT');
    reqPut.flush(updatedPos);
    await Promise.resolve();

    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
    reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-05T00:00:00Z', posicoes: [updatedPos] });

    const res = await p;
    expect(res.quantidade_total).toBe('145.00');
    expect(store.posicao()?.quantidade_total).toBe('145.00');
  });

  it('excluirLote: deve invocar DELETE /lotes/{id}, atualizar posicao e recarregar todasPosicoes', async () => {
    const updatedPos: PosicaoRendaFixa = {
      ...fakeLotesResp.posicoes[0],
      lotes: fakeLotesResp.posicoes[0].lotes.slice(1),
    };

    store.posicao.set(fakeLotesResp.posicoes[0]);

    const p = store.excluirLote(1);

    const reqDel = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes/1');
    expect(reqDel.request.method).toBe('DELETE');
    reqDel.flush(updatedPos);
    await Promise.resolve();

    const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
    reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-05T00:00:00Z', posicoes: [updatedPos] });

    const res = await p;
    expect(res.lotes.length).toBe(fakeLotesResp.posicoes[0].lotes.length - 1);
    expect(store.posicao()?.lotes.length).toBe(fakeLotesResp.posicoes[0].lotes.length - 1);
  });

  it('abrirModal e fecharModal: devem controlar o sinal modalState', () => {
    expect(store.modalState().open).toBeFalse();

    store.abrirModal('EDITAR_TITULO');
    expect(store.modalState().open).toBeTrue();
    expect(store.modalState().mode).toBe('EDITAR_TITULO');

    store.fecharModal();
    expect(store.modalState().open).toBeFalse();
    expect(store.modalState().mode).toBe('NOVO_TITULO');
  });

  describe('Carteira Completa (ativoId === 0)', () => {
    const fakeAtivo2: AtivoRendaFixa = {
      id: 2,
      ticker: 'CDB-INTER-110',
      nome: 'CDB Banco Inter 110% CDI',
      tipo: 'RendaFixa' as any,
      detalhes_rf: {
        ativo_id: 2,
        produto: 'CDB',
        indexador: 'CDI',
        emissor: 'Banco Inter',
        percentual_indexador: 110,
        data_vencimento: '2028-12-31',
        isento_ir: false,
        cobra_custodia_b3: false,
      },
    };

    const fakePosicao2: PosicaoRendaFixa = {
      ativo: fakeAtivo2,
      lotes: [
        {
          transacao_id: 10,
          data_compra: '2026-02-15',
          taxa_contratada: 110,
          preco_unitario: 1000,
          quantidade_original: 10,
          quantidade_aberta: 10,
          custo_aberto_brl: 10000,
          custo_conhecido: true,
        },
        {
          transacao_id: 11,
          data_compra: '2026-08-20',
          taxa_contratada: 110,
          preco_unitario: 1000,
          quantidade_original: 5,
          quantidade_aberta: 5,
          custo_aberto_brl: 5000,
          custo_conhecido: true,
        },
        {
          transacao_id: 12,
          data_compra: '2026-09-01',
          taxa_contratada: null,
          preco_unitario: 1000,
          quantidade_original: 2,
          quantidade_aberta: 2,
          custo_aberto_brl: 2000,
          custo_conhecido: false,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '17.00',
      custo_total_brl: '17000.00',
      pendencias: ['Lote 12 sem taxa contratada'],
    };

    beforeEach(() => {
      store.ativos.set([fakeAtivo, fakeAtivo2]);
      store.todasPosicoes.set([fakeLotesResp.posicoes[0], fakePosicao2]);
      store.ativoId.set(0);
      store.patchPremissas({
        refDate: '2026-10-05',
        refPrice: 243.38,
        refRate: '',
        ipcaCal: 4.5,
        ipcaProj: 4.5,
        cdiRatePct: 10.75,
        custody: { custMode: 'single', cust1: 0.5 },
      });
    });

    it('isCarteiraCompleta deve ser true quando ativoId for 0 e false caso contrário', () => {
      expect(store.isCarteiraCompleta()).toBeTrue();
      store.ativoId.set(1);
      expect(store.isCarteiraCompleta()).toBeFalse();
      store.ativoId.set(null);
      expect(store.isCarteiraCompleta()).toBeFalse();
    });

    it('totalTitulos e totalLotesAtivos calculam o total correto da carteira consolidada', () => {
      expect(store.totalTitulos()).toBe(2);
      // fakeAtivo tem 4 lotes abertos, fakeAtivo2 tem 3 lotes abertos
      expect(store.totalLotesAtivos()).toBe(7);
    });

    it('vendaHojeConsolidada agrega custo, bruto, impostos e ordena os lotes cronologicamente', () => {
      const vHoje = store.vendaHoje();
      expect(vHoje).toBeTruthy();

      // Verifica soma de custo: 24658.92 + 15000.00 = 39658.92
      expect(vHoje.custo).toBeCloseTo(24658.92 + 15000, 1);
      // Bruto consolidado deve ser maior que o custo (rendimento positivo)
      expect(vHoje.bruto).toBeGreaterThan(vHoje.custo);
      expect(vHoje.liqReal).toBeGreaterThan(0);
      expect(vHoje.liqApp).toBeGreaterThan(0);

      // Quantidade de fatias consolidadas
      expect(vHoje.parts.length).toBe(6);

      // Ordenação cronológica estrita por data_compra:
      // 1. 2026-01-23 (lote 1, ativo 1)
      // 2. 2026-02-15 (lote 10, ativo 2)
      // 3. 2026-03-24 (lote 2, ativo 1)
      // 4. 2026-06-08 (lote 3, ativo 1)
      // 5. 2026-07-30 (lote 4, ativo 1)
      // 6. 2026-08-20 (lote 11, ativo 2)
      expect(vHoje.parts[0].lot.date).toBe('2026-01-23');
      expect(vHoje.parts[0].ativo?.id).toBe(1);
      expect(vHoje.parts[1].lot.date).toBe('2026-02-15');
      expect(vHoje.parts[1].ativo?.id).toBe(2);
      expect(vHoje.parts[2].lot.date).toBe('2026-03-24');
      expect(vHoje.parts[3].lot.date).toBe('2026-06-08');
      expect(vHoje.parts[4].lot.date).toBe('2026-07-30');
      expect(vHoje.parts[5].lot.date).toBe('2026-08-20');
      expect(vHoje.parts[5].ativo?.id).toBe(2);
    });

    it('posTIR calcula a taxa interna de retorno consolidada considerando fluxos de todos os títulos', () => {
      const tir = store.posTIR();
      expect(tir).not.toBeNull();
      expect(tir!).toBeGreaterThan(0);
      expect(tir!).toBeLessThan(1); // TIR razoável anual
    });

    it('alocacaoTitulo deve gerar fatias percentuais proporcionais ao saldo bruto de cada título', () => {
      const fatias = store.alocacaoTitulo();
      expect(fatias.length).toBe(2);
      expect(fatias[0].label).toBe('TD-RENDA+-2065');
      expect(fatias[1].label).toBe('CDB-INTER-110');

      const somaPct = fatias.reduce((acc, f) => acc + f.pct, 0);
      expect(somaPct).toBeCloseTo(1, 2);
    });

    it('alocacaoIndexador deve consolidar por indexador em Carteira Completa', () => {
      const fatias = store.alocacaoIndexador();
      expect(fatias.length).toBe(2);
      const labels = fatias.map(f => f.label);
      expect(labels.some(l => l.includes('IPCA'))).toBeTrue();
      expect(labels.some(l => l.includes('CDI'))).toBeTrue();
    });

    it('lotesPendentes agrega pendências de todos os títulos na carteira completa', () => {
      const pendencias = store.lotesPendentes();
      expect(pendencias.length).toBe(1);
      expect(pendencias[0].transacao_id).toBe(12);
      expect(pendencias[0].ativo.id).toBe(2);
      expect(pendencias[0].ativo.ticker).toBe('CDB-INTER-110');
    });

    it('projecao consolida as curvas somando o saldo de todos os ativos', () => {
      const proj = store.projecao();
      expect(proj.labels.length).toBe(21); // 0 a 10 anos em passos semestrais
      expect(proj.series.alvo.length).toBe(21);
      expect(proj.series.carrego.length).toBe(21);

      expect(proj.series.alvo[0]).toBeGreaterThan(0);
      expect(proj.series.carrego[0]).toBeGreaterThan(0);
    });

    it('selecionarAtivo(0) salva 0 no localStorage e limpa a posicao individual', async () => {
      spyOn(localStorage, 'setItem');
      store.posicao.set(fakeLotesResp.posicoes[0]);

      const p = store.selecionarAtivo(0);
      const req = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1');
      req.flush(fakeLotesResp);
      await p;

      expect(store.ativoId()).toBe(0);
      expect(store.posicao()).toBeNull();
      expect(localStorage.setItem).toHaveBeenCalledWith('il.rendafixa.ativo_selecionado.v1', '0');
    });

    it('posRealReturnPct deve retornar 0 quando o custo total investido for 0', () => {
      store.todasPosicoes.set([]);
      expect(store.vendaHoje().custo).toBe(0);
      expect(store.posRealReturnPct()).toBe(0);
    });

    it('alocacaoTitulo filtra ativos com saldo 0 ou sem lotes', () => {
      const posVazia: PosicaoRendaFixa = {
        ativo: { id: 99, ticker: 'CDB-VAZIO', nome: 'CDB Vazio', tipo: 'RendaFixa' as any },
        lotes: [],
        fluxos_recebidos: [],
        quantidade_total: '0',
        custo_total_brl: '0',
        pendencias: [],
      };
      store.todasPosicoes.set([fakeLotesResp.posicoes[0], fakePosicao2, posVazia]);
      const fatias = store.alocacaoTitulo();
      expect(fatias.some((f) => f.label === 'CDB-VAZIO')).toBeFalse();
      expect(fatias.length).toBe(2);
    });

    it('salvarTaxa em modo ativo individual atualiza a posição sem truncar todasPosicoes', async () => {
      store.ativoId.set(1);
      store.posicao.set(fakeLotesResp.posicoes[0]);
      store.todasPosicoes.set([fakeLotesResp.posicoes[0], fakePosicao2]);

      const updatedPos1: PosicaoRendaFixa = {
        ...fakeLotesResp.posicoes[0],
        lotes: [
          {
            ...fakeLotesResp.posicoes[0].lotes[0],
            taxa_contratada: '7.50',
          },
          ...fakeLotesResp.posicoes[0].lotes.slice(1),
        ],
      };

      const p = store.salvarTaxa(1, 7.50);

      const reqPatch = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/transacoes/1/taxa');
      expect(reqPatch.request.method).toBe('PATCH');
      reqPatch.flush({ id: 1, taxa_contratada: '7.50' });
      await Promise.resolve();

      const reqLotes = httpMock.expectOne('http://127.0.0.1:8000/api/v1/renda-fixa/lotes?carteira_id=1&ativo_id=1');
      reqLotes.flush({ carteira_id: 1, gerado_em: '2026-10-05T00:00:00Z', posicoes: [updatedPos1] });

      await p;
      // Posicao 1 foi atualizada
      expect(store.posicao()?.lotes[0].taxa_contratada).toBe('7.50');
      // todasPosicoes AINDA contém ambas as posições (não foi truncada para 1!)
      expect(store.todasPosicoes().length).toBe(2);
      expect(store.todasPosicoes().some((p) => p.ativo.id === 2)).toBeTrue();
    });
  });
});



