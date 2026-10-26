import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CarteiraStore, FILTRO_CLASSE_STORAGE_KEY } from './carteira.store';
import { CarteiraService } from '../../../core/services/carteira.service';
import {
  AjusteManualPosicaoDto,
  Ativo,
  AtivoUpdateDto,
  ConversaoTickerDto,
  CotacoesCarteiraResponse,
  FiltroClasseCarteira,
  PosicaoConsolidada,
  ProventosAtivoAnual,
  Transacao,
  TransacaoCreateDto,
  TransacaoUpdateDto,
} from '../../../core/models/investimento.models';
import { signal } from '@angular/core';

describe('CarteiraStore', () => {
  let store: CarteiraStore;
  let mockService: jasmine.SpyObj<CarteiraService>;

  const ativoPetr4: Ativo = {
    id: 1,
    ticker: 'PETR4',
    nome: 'Petróleo Brasileiro S.A.',
    tipo: 'Acao',
    setor: 'Petróleo e Gás',
  };

  const ativoHglg11: Ativo = {
    id: 2,
    ticker: 'HGLG11',
    nome: 'CSHG Logística FII',
    tipo: 'FII',
    setor: 'Logística',
  };

  const ativoBtc: Ativo = {
    id: 3,
    ticker: 'BTC',
    nome: 'Bitcoin',
    tipo: 'Cripto',
    setor: 'Criptomoedas',
  };

  const ativoRf: Ativo = {
    id: 4,
    ticker: 'TD-RENDA+-2065',
    nome: 'Tesouro RendA+ 2065',
    tipo: 'RendaFixa',
    setor: 'Títulos Públicos',
  };

  const ativoCustoZero: Ativo = {
    id: 5,
    ticker: 'VALE3',
    nome: 'Vale S.A.',
    tipo: 'Acao',
    setor: 'Mineração',
  };

  const ativoEncerrado: Ativo = {
    id: 6,
    ticker: 'BBAS3',
    nome: 'Banco do Brasil S.A.',
    tipo: 'Acao',
    setor: 'Financeiro',
  };

  const mockPosicoes: PosicaoConsolidada[] = [
    {
      id: 101,
      carteira_id: 1,
      ativo_id: 1,
      quantidade_saldo: 100,
      custo_total_brl: 3000,
      preco_medio_brl: 30,
      proventos_acumulados_brl: 300,
      lucro_realizado_brl: 0,
      dividendo_por_acao_brl: 3,
      preco_medio_ajustado_brl: 27,
      yoc_acumulado_pct: 10,
      data_atualizacao: '2026-10-16T12:00:00Z',
      ativo: ativoPetr4,
    },
    {
      id: 102,
      carteira_id: 1,
      ativo_id: 2,
      quantidade_saldo: 10,
      custo_total_brl: 1600,
      preco_medio_brl: 160,
      proventos_acumulados_brl: 160,
      lucro_realizado_brl: 50,
      dividendo_por_acao_brl: 16,
      preco_medio_ajustado_brl: 144,
      yoc_acumulado_pct: 10,
      data_atualizacao: '2026-10-16T12:00:00Z',
      ativo: ativoHglg11,
    },
    {
      id: 103,
      carteira_id: 1,
      ativo_id: 3,
      quantidade_saldo: 0.1,
      custo_total_brl: 30000,
      preco_medio_brl: 300000,
      proventos_acumulados_brl: 0,
      lucro_realizado_brl: 0,
      dividendo_por_acao_brl: 0,
      preco_medio_ajustado_brl: 300000,
      yoc_acumulado_pct: 0,
      data_atualizacao: '2026-10-16T12:00:00Z',
      ativo: ativoBtc,
    },
    {
      id: 104,
      carteira_id: 1,
      ativo_id: 4,
      quantidade_saldo: 50,
      custo_total_brl: 5000,
      preco_medio_brl: 100,
      proventos_acumulados_brl: 200,
      lucro_realizado_brl: 0,
      dividendo_por_acao_brl: 4,
      preco_medio_ajustado_brl: 96,
      yoc_acumulado_pct: 4,
      data_atualizacao: '2026-10-16T12:00:00Z',
      ativo: ativoRf,
    },
    {
      id: 105,
      carteira_id: 1,
      ativo_id: 5,
      quantidade_saldo: 20,
      custo_total_brl: 0,
      preco_medio_brl: 0, // Custo pendente (A definir)
      proventos_acumulados_brl: 0,
      lucro_realizado_brl: 0,
      dividendo_por_acao_brl: 0,
      preco_medio_ajustado_brl: 0,
      yoc_acumulado_pct: 0,
      data_atualizacao: '2026-10-16T12:00:00Z',
      ativo: ativoCustoZero,
    },
    {
      id: 106,
      carteira_id: 1,
      ativo_id: 6,
      quantidade_saldo: 0, // Posição encerrada com histórico
      custo_total_brl: 0,
      preco_medio_brl: 0,
      proventos_acumulados_brl: 500, // Provento histórico preservado
      lucro_realizado_brl: 1200, // Lucro realizado em vendas preservado
      dividendo_por_acao_brl: 0,
      preco_medio_ajustado_brl: 0,
      yoc_acumulado_pct: 0,
      data_atualizacao: '2026-10-16T12:00:00Z',
      ativo: ativoEncerrado,
    },
  ];

  const mockCotacoesResponse: CotacoesCarteiraResponse = {
    carteira_id: 1,
    atualizado_em: '2026-10-16T12:30:00Z',
    stale: false,
    cotacoes: {
      PETR4: {
        ticker: 'PETR4',
        preco_atual: 35,
        variacao_diaria_pct: 1.5,
        fonte: 'YAHOO',
        stale: false,
      },
      HGLG11: {
        ticker: 'HGLG11',
        preco_atual: 170,
        variacao_diaria_pct: -0.2,
        fonte: 'BRAPI',
        stale: false,
      },
      BTC: {
        ticker: 'BTC',
        preco_atual: 350000,
        variacao_diaria_pct: 3.0,
        fonte: 'YAHOO',
        stale: false,
      },
      VALE3: {
        ticker: 'VALE3',
        preco_atual: 60,
        variacao_diaria_pct: 0.5,
        fonte: 'CACHE',
        stale: false,
      },
    },
  };

  const mockProventosAnuais: ProventosAtivoAnual[] = [
    {
      ativo_id: 1,
      ticker: 'PETR4',
      nome: 'Petróleo Brasileiro S.A.',
      tipo_ativo: 'Acao',
      em_custodia: true,
      quantidade_saldo: 100,
      total_dividendos_brl: 200,
      total_jcp_brl: 100,
      total_rendimentos_brl: 0,
      total_div_jcp_brl: 300,
      total_geral_brl: 300,
      pct_dividendo_total: 66.67,
      pct_jcp_total: 33.33,
      anos: [
        {
          ano: 2024,
          dividendos_brl: 200,
          jcp_brl: 100,
          rendimentos_brl: 0,
          total_div_jcp_brl: 300,
          total_geral_brl: 300,
          pct_dividendo: 66.67,
          pct_jcp: 33.33,
          qtd_pagamentos_dividendo: 2,
          qtd_pagamentos_jcp: 1,
          qtd_pagamentos_rendimento: 0,
        },
      ],
    },
    {
      ativo_id: 2,
      ticker: 'HGLG11',
      nome: 'CSHG Logística FII',
      tipo_ativo: 'FII',
      em_custodia: true,
      quantidade_saldo: 10,
      total_dividendos_brl: 0,
      total_jcp_brl: 0,
      total_rendimentos_brl: 160,
      total_div_jcp_brl: 0,
      total_geral_brl: 160,
      pct_dividendo_total: 0,
      pct_jcp_total: 0,
      anos: [
        {
          ano: 2024,
          dividendos_brl: 0,
          jcp_brl: 0,
          rendimentos_brl: 160,
          total_div_jcp_brl: 0,
          total_geral_brl: 160,
          pct_dividendo: 0,
          pct_jcp: 0,
          qtd_pagamentos_dividendo: 0,
          qtd_pagamentos_jcp: 0,
          qtd_pagamentos_rendimento: 12,
        },
      ],
    },
    {
      ativo_id: 6,
      ticker: 'BBAS3',
      nome: 'Banco do Brasil S.A.',
      tipo_ativo: 'Acao',
      em_custodia: false,
      quantidade_saldo: 0,
      total_dividendos_brl: 300,
      total_jcp_brl: 200,
      total_rendimentos_brl: 0,
      total_div_jcp_brl: 500,
      total_geral_brl: 500,
      pct_dividendo_total: 60,
      pct_jcp_total: 40,
      anos: [],
    },
  ];

  beforeEach(() => {
    localStorage.clear();

    const spy = jasmine.createSpyObj<CarteiraService>('CarteiraService', [
      'getPosicoes',
      'obterCotacoes',
      'obterProventosAnuais',
      'recalcularCarteira',
      'ajustarPosicaoManual',
      'atualizarAtivo',
      'definirCotacaoManual',
      'converterTicker',
      'excluirAtivo',
      'listarTransacoes',
      'criarTransacao',
      'atualizarTransacao',
      'excluirTransacao',
    ]);

    // Signals no mock service
    (spy as any).carteiras = signal([{ id: 1, nome: 'Carteira Principal' }]);
    (spy as any).carteiraAtivaId = signal(1);

    spy.getPosicoes.and.returnValue(of(mockPosicoes));
    spy.obterCotacoes.and.returnValue(of(mockCotacoesResponse));
    spy.obterProventosAnuais.and.returnValue(of({ carteira_id: 1, ativos: mockProventosAnuais }));
    spy.recalcularCarteira.and.returnValue(of({ status: 'success', mensagem: 'ok' }));
    spy.ajustarPosicaoManual.and.returnValue(of(mockPosicoes[0]));
    spy.atualizarAtivo.and.returnValue(of(ativoPetr4));
    spy.definirCotacaoManual.and.returnValue(of(ativoPetr4));
    spy.converterTicker.and.returnValue(of(ativoPetr4));
    spy.excluirAtivo.and.returnValue(of(void 0));
    spy.listarTransacoes.and.returnValue(of([]));
    spy.criarTransacao.and.returnValue(of({} as any));
    spy.atualizarTransacao.and.returnValue(of({} as any));
    spy.excluirTransacao.and.returnValue(of(void 0));

    TestBed.configureTestingModule({
      providers: [
        CarteiraStore,
        { provide: CarteiraService, useValue: spy },
      ],
    });

    mockService = TestBed.inject(CarteiraService) as jasmine.SpyObj<CarteiraService>;
    store = TestBed.inject(CarteiraStore);
  });

  describe('Inicialização e Carregamento', () => {
    it('deve inicializar com filtro RV_TOTAL como default', () => {
      expect(store.filtroClasse()).toBe('RV_TOTAL');
    });

    it('deve carregar posições e cotações em paralelo com sucesso', async () => {
      await store.carregarDados(1);

      expect(mockService.getPosicoes).toHaveBeenCalledWith(1, false);
      expect(mockService.obterCotacoes).toHaveBeenCalledWith(1, false);
      expect(store.todasPosicoes().length).toBe(6);
      expect(store.cotacoesMap()['PETR4'].preco_atual).toBe(35);
      expect(store.cotacoesMeta().atualizadoEm).toBe('2026-10-16T12:30:00Z');
      expect(store.loading()).toBeFalse();
      expect(store.error()).toBeNull();
    });

    it('deve capturar erro se carregarDados falhar', async () => {
      mockService.getPosicoes.and.returnValue(
        throwError(() => ({ error: { detail: 'Falha de conexão com a API' } })),
      );

      await store.carregarDados(1);

      expect(store.loading()).toBeFalse();
      expect(store.error()).toBe('Falha de conexão com a API');
    });

    it('deve continuar carregando posições se obterCotacoes falhar', async () => {
      mockService.obterCotacoes.and.returnValue(
        throwError(() => ({ error: { detail: 'Yahoo API timeout' } })),
      );

      await store.carregarDados(1);

      expect(store.todasPosicoes().length).toBe(6);
      expect(store.loading()).toBeFalse();
      expect(store.error()).toBeNull();
      expect(store.cotacoesMeta().stale).toBeTrue();
    });

    it('deve carregar carteira vazia sem disparar chamadas de cotações ou proventos', async () => {
      mockService.getPosicoes.calls.reset();
      mockService.obterCotacoes.calls.reset();
      mockService.obterProventosAnuais.calls.reset();

      mockService.getPosicoes.and.returnValue(of([]));

      await store.carregarDados(99);

      expect(mockService.getPosicoes).toHaveBeenCalledWith(99, false);
      expect(mockService.obterCotacoes).not.toHaveBeenCalled();
      expect(mockService.obterProventosAnuais).not.toHaveBeenCalled();
      expect(store.todasPosicoes().length).toBe(0);
      expect(Object.keys(store.cotacoesMap()).length).toBe(0);
      expect(store.proventosAnuaisAtivos().length).toBe(0);
      expect(store.loading()).toBeFalse();
      expect(store.error()).toBeNull();
    });

    it('não deve disparar requisições duplicadas concorrentes para a mesma carteira', async () => {
      mockService.getPosicoes.calls.reset();
      mockService.obterCotacoes.calls.reset();

      // Dispara duas chamadas simultâneas
      const p1 = store.carregarDados(1);
      const p2 = store.carregarDados(1);
      await Promise.all([p1, p2]);

      expect(mockService.getPosicoes.calls.count()).toBe(1);
    });
  });

  describe('Cálculos Financeiros e Enriquecimento (posicoesEnriquecidas)', () => {
    beforeEach(async () => {
      await store.carregarDados(1);
    });

    it('deve enriquecer ativo de Ação padrão (PETR4) com cálculos corretos', () => {
      const petr4 = store.posicoesEnriquecidas().find((p) => p.ativo.ticker === 'PETR4')!;
      expect(petr4).toBeDefined();

      // Quantidade e PM
      expect(petr4.quantidade).toBe(100);
      expect(petr4.pmContabil).toBe(30);
      expect(petr4.custoTotal).toBe(3000);
      expect(petr4.custoPendente).toBeFalse();

      // Proventos e PM Ajustado
      expect(petr4.proventosTotal).toBe(300);
      expect(petr4.dividendoPorAcao).toBe(3); // 300 / 100
      expect(petr4.pmAjustado).toBe(27); // 30 - 3

      // Cotação e Mercado
      expect(petr4.cotacaoAtual).toBe(35);
      expect(petr4.fonteCotacao).toBe('YAHOO');
      expect(petr4.variacaoDiariaPct).toBe(1.5);
      expect(petr4.valorMercado).toBe(3500); // 100 * 35

      // Rentabilidade
      expect(petr4.lucroNaoRealizadoBrl).toBe(500); // 3500 - 3000
      expect(petr4.rentabCotaPct).toBeCloseTo(16.6667, 3); // (500 / 3000) * 100
      expect(petr4.retornoTotalBrl).toBe(800); // 500 (aberto) + 300 (prov) + 0 (realizado)
      expect(petr4.rentabTotalComDivPct).toBeCloseTo(26.6667, 3); // (800 / 3000) * 100
      expect(petr4.yocPct).toBe(10); // (300 / 3000) * 100
    });

    it('deve enriquecer ativo FII (HGLG11) com lucro realizado anterior', () => {
      const hglg11 = store.posicoesEnriquecidas().find((p) => p.ativo.ticker === 'HGLG11')!;
      expect(hglg11).toBeDefined();

      expect(hglg11.quantidade).toBe(10);
      expect(hglg11.pmContabil).toBe(160);
      expect(hglg11.custoTotal).toBe(1600);
      expect(hglg11.proventosTotal).toBe(160);
      expect(hglg11.dividendoPorAcao).toBe(16);
      expect(hglg11.pmAjustado).toBe(144); // 160 - 16
      expect(hglg11.valorMercado).toBe(1700); // 10 * 170
      expect(hglg11.lucroNaoRealizadoBrl).toBe(100); // 1700 - 1600
      expect(hglg11.lucroRealizadoBrl).toBe(50);
      expect(hglg11.retornoTotalBrl).toBe(310); // 100 (aberto) + 160 (prov) + 50 (realizado)
      expect(hglg11.rentabTotalComDivPct).toBeCloseTo(16.25, 2); // ((1700 + 160 - 1600) / 1600) * 100
    });

    it('deve identificar e tratar ativo com custo pendente (VALE3 / custo zero)', () => {
      const vale3 = store.posicoesEnriquecidas().find((p) => p.ativo.ticker === 'VALE3')!;
      expect(vale3).toBeDefined();

      expect(vale3.quantidade).toBe(20);
      expect(vale3.pmContabil).toBe(0);
      expect(vale3.custoPendente).toBeTrue(); // quantidade > 0 e pmContabil <= 0
      expect(vale3.valorMercado).toBe(1200); // 20 * 60 (cotação do cache)
      expect(vale3.lucroNaoRealizadoBrl).toBe(0); // Não distorce enquanto pendente
      expect(vale3.rentabCotaPct).toBe(0); // Não divide por zero
      expect(vale3.pmAjustado).toBe(0);
    });

    it('deve utilizar fallback de cotação: cotação manual > preço médio > zero', () => {
      // Ativo RF sem cotação online no mockCotacoesResponse
      const rf = store.posicoesEnriquecidas().find((p) => p.ativo.ticker === 'TD-RENDA+-2065')!;
      expect(rf).toBeDefined();
      // Não tem no mockCotacoesResponse, nem cotacao_manual, então usa pmContabil = 100
      expect(rf.cotacaoAtual).toBe(100);
      expect(rf.fonteCotacao).toBe('INDISPONIVEL');
      expect(rf.valorMercado).toBe(5000); // 50 * 100
    });

    it('deve usar cotação manual do Ativo quando definida', async () => {
      const ativoComManual: Ativo = {
        ...ativoPetr4,
        ticker: 'PETR3',
        cotacao_manual: 42.0,
      };
      const posComManual: PosicaoConsolidada = {
        id: 999,
        carteira_id: 1,
        ativo_id: 999,
        quantidade_saldo: 10,
        custo_total_brl: 300,
        preco_medio_brl: 30,
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 30,
        yoc_acumulado_pct: 0,
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: ativoComManual,
      };

      store.todasPosicoes.set([posComManual]);
      store.cotacoesMap.set({}); // sem cotação de mercado para PETR3

      const item = store.posicoesEnriquecidas()[0];
      expect(item.cotacaoAtual).toBe(42.0);
      expect(item.fonteCotacao).toBe('MANUAL');
      expect(item.valorMercado).toBe(420);
    });

    it('deve priorizar cotação manual do Ativo mesmo se houver cotação de mercado no cotacoesMap', () => {
      const ativoComManual: Ativo = {
        ...ativoPetr4,
        ticker: 'PETR4',
        cotacao_manual: 45.0,
      };
      const posComManual: PosicaoConsolidada = {
        id: 999,
        carteira_id: 1,
        ativo_id: 1,
        quantidade_saldo: 10,
        custo_total_brl: 300,
        preco_medio_brl: 30,
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 30,
        yoc_acumulado_pct: 0,
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: ativoComManual,
      };

      store.todasPosicoes.set([posComManual]);
      store.cotacoesMap.set({
        PETR4: {
          ticker: 'PETR4',
          preco_atual: 35.0,
          fonte: 'YAHOO',
          variacao_diaria_pct: 2.5,
          stale: false,
        },
      });

      const item = store.posicoesEnriquecidas()[0];
      expect(item.cotacaoAtual).toBe(45.0);
      expect(item.fonteCotacao).toBe('MANUAL');
      expect(item.variacaoDiariaPct).toBe(2.5);
      expect(item.valorMercado).toBe(450);
    });

    it('deve limitar pmAjustado a zero quando proventos por ação superam o PM contábil', () => {
      const posAltaDiv: PosicaoConsolidada = {
        id: 888,
        carteira_id: 1,
        ativo_id: 888,
        quantidade_saldo: 10,
        custo_total_brl: 100,
        preco_medio_brl: 10,
        proventos_acumulados_brl: 250, // 25 por ação
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 25,
        preco_medio_ajustado_brl: 0,
        yoc_acumulado_pct: 250,
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: { id: 888, ticker: 'SUPERDIV', nome: 'Super Div S.A.', tipo: 'Acao' },
      };

      store.todasPosicoes.set([posAltaDiv]);
      const item = store.posicoesEnriquecidas()[0];

      expect(item.dividendoPorAcao).toBe(25);
      expect(item.pmAjustado).toBe(0); // max(0, 10 - 25) = 0
    });
  });

  describe('Filtros de Classe e posicoesFiltradasAtivas', () => {
    beforeEach(async () => {
      await store.carregarDados(1);
    });

    it('no filtro RV_TOTAL (default) deve exibir apenas Ações e FIIs com saldo > 0', () => {
      store.setFiltroClasse('RV_TOTAL');
      const ativas = store.posicoesFiltradasAtivas();

      // Devem constar PETR4 (Acao), HGLG11 (FII), VALE3 (Acao).
      // BBAS3 não deve constar porque quantidade == 0.
      // BTC (Cripto) e TD-RENDA+-2065 (RF) não devem constar.
      const tickers = ativas.map((p) => p.ativo.ticker);
      expect(tickers).toEqual(jasmine.arrayContaining(['PETR4', 'HGLG11', 'VALE3']));
      expect(tickers).not.toContain('BTC');
      expect(tickers).not.toContain('TD-RENDA+-2065');
      expect(tickers).not.toContain('BBAS3');
    });

    it('no filtro ACAO deve exibir somente Ações ativas', () => {
      store.setFiltroClasse('ACAO');
      const ativas = store.posicoesFiltradasAtivas();
      const tickers = ativas.map((p) => p.ativo.ticker);

      expect(tickers).toEqual(jasmine.arrayContaining(['PETR4', 'VALE3']));
      expect(tickers).not.toContain('HGLG11');
      expect(tickers).not.toContain('BTC');
    });

    it('no filtro FII deve exibir somente FIIs ativos', () => {
      store.setFiltroClasse('FII');
      const ativas = store.posicoesFiltradasAtivas();
      expect(ativas.length).toBe(1);
      expect(ativas[0].ativo.ticker).toBe('HGLG11');
    });

    it('no filtro CRIPTO deve exibir somente Criptoativos ativos', () => {
      store.setFiltroClasse('CRIPTO');
      const ativas = store.posicoesFiltradasAtivas();
      expect(ativas.length).toBe(1);
      expect(ativas[0].ativo.ticker).toBe('BTC');
    });

    it('no filtro RENDA_FIXA deve exibir somente Renda Fixa ativa', () => {
      store.setFiltroClasse('RENDA_FIXA');
      const ativas = store.posicoesFiltradasAtivas();
      expect(ativas.length).toBe(1);
      expect(ativas[0].ativo.ticker).toBe('TD-RENDA+-2065');
    });

    it('no filtro PATRIMONIO deve exibir todas as classes ativas juntas', () => {
      store.setFiltroClasse('PATRIMONIO');
      const ativas = store.posicoesFiltradasAtivas();
      const tickers = ativas.map((p) => p.ativo.ticker);

      expect(tickers).toEqual(
        jasmine.arrayContaining(['PETR4', 'HGLG11', 'BTC', 'TD-RENDA+-2065', 'VALE3']),
      );
      expect(tickers).not.toContain('BBAS3'); // Encerrada
    });

    it('deve persistir e restaurar filtro de classe no localStorage', () => {
      store.setFiltroClasse('FII');
      expect(localStorage.getItem(FILTRO_CLASSE_STORAGE_KEY)).toBe('FII');
    });

    it('deve calcular pesoCarteiraPct proporcional ao total da aba filtrada', () => {
      // No filtro RV_TOTAL:
      // PETR4: valorMercado = 3500
      // HGLG11: valorMercado = 1700
      // VALE3: valorMercado = 1200
      // Total da aba = 6400
      store.setFiltroClasse('RV_TOTAL');
      const ativas = store.posicoesFiltradasAtivas();

      const petr4 = ativas.find((p) => p.ativo.ticker === 'PETR4')!;
      const hglg11 = ativas.find((p) => p.ativo.ticker === 'HGLG11')!;
      const vale3 = ativas.find((p) => p.ativo.ticker === 'VALE3')!;

      expect(petr4.pesoCarteiraPct).toBeCloseTo((3500 / 6400) * 100, 2);
      expect(hglg11.pesoCarteiraPct).toBeCloseTo((1700 / 6400) * 100, 2);
      expect(vale3.pesoCarteiraPct).toBeCloseTo((1200 / 6400) * 100, 2);

      // Soma dos pesos da aba deve dar 100%
      const somaPesos = ativas.reduce((acc, p) => acc + p.pesoCarteiraPct, 0);
      expect(somaPesos).toBeCloseTo(100, 1);
    });

    it('deve filtrar posições pela buscaTexto (ticker, nome, setor)', () => {
      store.setFiltroClasse('PATRIMONIO');

      // Busca por ticker
      store.setBuscaTexto('btc');
      expect(store.posicoesFiltradasAtivas().length).toBe(1);
      expect(store.posicoesFiltradasAtivas()[0].ativo.ticker).toBe('BTC');

      // Busca por setor
      store.setBuscaTexto('logística');
      expect(store.posicoesFiltradasAtivas().length).toBe(1);
      expect(store.posicoesFiltradasAtivas()[0].ativo.ticker).toBe('HGLG11');

      // Limpa busca
      store.setBuscaTexto('');
      expect(store.posicoesFiltradasAtivas().length).toBe(5);
    });

    it('deve ordenar posições por coluna e alternar direção', () => {
      store.setFiltroClasse('RV_TOTAL');

      // Ordenar por valorMercado desc (padrão)
      store.setOrdenacao('valorMercado', 'desc');
      let ativas = store.posicoesFiltradasAtivas();
      expect(ativas[0].ativo.ticker).toBe('PETR4'); // 3500
      expect(ativas[1].ativo.ticker).toBe('HGLG11'); // 1700
      expect(ativas[2].ativo.ticker).toBe('VALE3'); // 1200

      // Inverter direção para asc
      store.setOrdenacao('valorMercado');
      ativas = store.posicoesFiltradasAtivas();
      expect(ativas[0].ativo.ticker).toBe('VALE3'); // 1200
      expect(ativas[2].ativo.ticker).toBe('PETR4'); // 3500

      // Ordenar alfabeticamente por ticker asc
      store.setOrdenacao('ticker');
      ativas = store.posicoesFiltradasAtivas();
      expect(ativas[0].ativo.ticker).toBe('HGLG11');
      expect(ativas[2].ativo.ticker).toBe('VALE3');
    });

    it('deve ordenar com segurança campos nulos ou indefinidos sem quebrar', () => {
      store.setFiltroClasse('RV_TOTAL');
      store.setOrdenacao('setor', 'asc');
      const ativas = store.posicoesFiltradasAtivas();
      expect(ativas.length).toBe(3);
    });
  });

  describe('Os 6 KPIs Consolidados (kpis)', () => {
    beforeEach(async () => {
      await store.carregarDados(1);
    });

    it('deve calcular os 6 KPIs com precisão na aba RV_TOTAL (incluindo proventos e realizado de encerradas)', () => {
      store.setFiltroClasse('RV_TOTAL');
      const kpis = store.kpis();

      // Ativos ativos da classe RV_TOTAL:
      // PETR4: custo = 3000, mercado = 3500, lucroNaoRealizado = 500, proventos = 300, realizado = 0
      // HGLG11: custo = 1600, mercado = 1700, lucroNaoRealizado = 100, proventos = 160, realizado = 50
      // VALE3: custo = 0, mercado = 1200, lucroNaoRealizado = 0 (custoPendente), proventos = 0, realizado = 0
      // Ativos encerrados da classe (Acao):
      // BBAS3: saldo = 0, proventos = 500, realizado = 1200

      // 1. Montante Aportado e contagem de ativos
      expect(kpis.montanteAportadoBrl).toBe(4600); // 3000 + 1600 + 0
      expect(kpis.qtdAtivosCustodia).toBe(3); // PETR4, HGLG11, VALE3
      expect(kpis.qtdAtivosCustoPendente).toBe(1); // VALE3

      // 2. Patrimônio Atual a Mercado
      expect(kpis.patrimonioMercadoBrl).toBe(6400); // 3500 + 1700 + 1200

      // 3. Valorização da Cota (Aberto)
      expect(kpis.valorizacaoCotaBrl).toBe(600); // 500 + 100 + 0
      // valorizacaoCotaPct calculado sobre os ativos com custo conhecido (3000 + 1600 = 4600)
      expect(kpis.valorizacaoCotaPct).toBeCloseTo((600 / 4600) * 100, 2); // 13.04%

      // 4. Proventos Recebidos (PETR4 300 + HGLG11 160 + BBAS3 encerrado 500 = 960)
      expect(kpis.proventosRecebidosBrl).toBe(960);
      expect(kpis.yocCarteiraPct).toBeCloseTo((960 / 4600) * 100, 2); // 20.87%

      // Redução Média de PM: custo ajustado ativos = (27 * 100) + (144 * 10) + (0 * 20) = 2700 + 1440 = 4140
      // Redução = ((4600 - 4140) / 4600) * 100 = (460 / 4600) * 100 = 10%
      expect(kpis.reducaoMediaPmPct).toBeCloseTo(10, 1);

      // 6. Lucro Realizado Total (HGLG11 50 + BBAS3 1200 = 1250)
      expect(kpis.lucroRealizadoTotalBrl).toBe(1250);

      // 5. Retorno Total: valorizacao (600) + proventos (960) + realizado (1250) = 2810
      expect(kpis.retornoTotalBrl).toBe(2810);
      expect(kpis.retornoTotalPct).toBeCloseTo((2810 / 4600) * 100, 2); // 61.09%
    });

    it('deve recalcular os KPIs dinamicamente ao trocar de aba para CRIPTO', () => {
      store.setFiltroClasse('CRIPTO');
      const kpis = store.kpis();

      expect(kpis.qtdAtivosCustodia).toBe(1);
      expect(kpis.qtdAtivosCustoPendente).toBe(0);
      expect(kpis.montanteAportadoBrl).toBe(30000);
      expect(kpis.patrimonioMercadoBrl).toBe(35000); // 0.1 * 350000
      expect(kpis.valorizacaoCotaBrl).toBe(5000);
      expect(kpis.valorizacaoCotaPct).toBeCloseTo((5000 / 30000) * 100, 2);
      expect(kpis.proventosRecebidosBrl).toBe(0);
      expect(kpis.lucroRealizadoTotalBrl).toBe(0);
      expect(kpis.retornoTotalBrl).toBe(5000);
    });
  });

  describe('Computed Signals para os 3 Gráficos', () => {
    beforeEach(async () => {
      await store.carregarDados(1);
    });

    it('chartAlocacaoClasseSetor deve agrupar por classe e por setor com percentuais corretos', () => {
      store.setFiltroClasse('PATRIMONIO');
      const chart = store.chartAlocacaoClasseSetor();

      expect(chart.porAtivo.labels.length).toBeGreaterThan(0);
      expect(chart.porClasse.labels.length).toBeGreaterThan(0);
      expect(chart.porSetor.labels.length).toBeGreaterThan(0);

      // Soma dos percentuais por ativo deve somar 100%
      const somaPctAtivo = chart.porAtivo.percentual.reduce((acc, v) => acc + v, 0);
      expect(somaPctAtivo).toBeCloseTo(100, 1);

      // Soma dos percentuais por classe deve somar 100%
      const somaPctClasse = chart.porClasse.percentual.reduce((acc, v) => acc + v, 0);
      expect(somaPctClasse).toBeCloseTo(100, 1);

      // Cripto deve ser a maior fatia em R$ (35.000)
      expect(chart.porClasse.labels[0]).toBe('Cripto');
      expect(chart.porClasse.data[0]).toBe(35000);
    });

    it('chartAlocacaoClasseSetor deve tratar ativos sem classe ou setor definido com fallback "Outros"', () => {
      const posSemSetor: PosicaoConsolidada = {
        id: 777,
        carteira_id: 1,
        ativo_id: 777,
        quantidade_saldo: 10,
        custo_total_brl: 100,
        preco_medio_brl: 10,
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 10,
        yoc_acumulado_pct: 0,
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: {
          id: 777,
          ticker: 'SEMSETOR',
          nome: 'Sem Setor',
          tipo: 'Acao',
          setor: null,
        },
      };

      store.todasPosicoes.set([posSemSetor]);
      store.cotacoesMap.set({});
      store.setFiltroClasse('PATRIMONIO');

      const chart = store.chartAlocacaoClasseSetor();
      expect(chart.porSetor.labels).toContain('Outros');
    });

    it('chartPesoAtivos deve listar ativos ordenados por peso no patrimônio', () => {
      store.setFiltroClasse('PATRIMONIO');
      const chart = store.chartPesoAtivos();

      // BTC é o maior ativo
      expect(chart.labels[0]).toBe('BTC');
      expect(chart.data[0]).toBe(35000);
      expect(chart.labels.length).toBe(5); // 5 ativos ativos
    });

    it('chartPesoAtivos deve agrupar excedentes em "Outros" se houver mais de 12 ativos', () => {
      const muitasPosicoes: PosicaoConsolidada[] = Array.from({ length: 15 }, (_, i) => ({
        id: 200 + i,
        carteira_id: 1,
        ativo_id: 200 + i,
        quantidade_saldo: 10,
        custo_total_brl: 100 * (15 - i),
        preco_medio_brl: 10 * (15 - i),
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 10 * (15 - i),
        yoc_acumulado_pct: 0,
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: {
          id: 200 + i,
          ticker: `TICK${i + 1}`,
          nome: `Ativo ${i + 1}`,
          tipo: 'Acao',
        },
      }));

      store.todasPosicoes.set(muitasPosicoes);
      store.cotacoesMap.set({}); // vai usar PM

      store.setFiltroClasse('PATRIMONIO');
      const chart = store.chartPesoAtivos();

      expect(chart.labels.length).toBe(12); // 11 + "Outros"
      expect(chart.labels[11]).toBe('Outros');
    });

    it('chartRankingProventos deve ordenar os maiores pagadores de dividendos', () => {
      store.setFiltroClasse('RV_TOTAL');
      const chart = store.chartRankingProventos();

      // BBAS3 teve 500, PETR4 teve 300, HGLG11 teve 160
      expect(chart.labels[0]).toBe('BBAS3');
      expect(chart.proventos[0]).toBe(500);

      expect(chart.labels[1]).toBe('PETR4');
      expect(chart.proventos[1]).toBe(300);

      expect(chart.labels[2]).toBe('HGLG11');
      expect(chart.proventos[2]).toBe(160);
    });
  });

  describe('Actions de CRUD e Modais', () => {
    it('atualizarCotacoes deve sincronizar e atualizar cotacoesMap', async () => {
      await store.atualizarCotacoes(true);

      expect(mockService.obterCotacoes).toHaveBeenCalledWith(1, true);
      expect(store.syncingCotacoes()).toBeFalse();
    });

    it('atualizarCotacoes deve capturar erro e atualizar sinal de erro', async () => {
      mockService.obterCotacoes.and.returnValue(
        throwError(() => ({ error: { detail: 'Yahoo indisponível' } })),
      );

      await store.atualizarCotacoes(true);

      expect(store.syncingCotacoes()).toBeFalse();
      expect(store.error()).toBe('Yahoo indisponível');
    });

    it('recalcular deve acionar endpoint e recarregar dados', async () => {
      await store.recalcular();

      expect(mockService.recalcularCarteira).toHaveBeenCalledWith(1);
      expect(mockService.getPosicoes).toHaveBeenCalled();
    });

    it('ajustarPosicaoManual deve enviar payload e recarregar carteira', async () => {
      const payload: AjusteManualPosicaoDto = {
        quantidade_saldo: 200,
        preco_medio_brl: 28,
        proventos_acumulados_brl: 400,
      };

      await store.ajustarPosicaoManual(1, payload);

      expect(mockService.ajustarPosicaoManual).toHaveBeenCalledWith(1, 1, payload);
      expect(mockService.getPosicoes).toHaveBeenCalled();
    });

    it('atualizarAtivo deve chamar serviço e recarregar', async () => {
      const payload: AtivoUpdateDto = { nome: 'Novo Nome', setor: 'Novo Setor' };
      await store.atualizarAtivo(1, payload);

      expect(mockService.atualizarAtivo).toHaveBeenCalledWith(1, payload);
      expect(mockService.getPosicoes).toHaveBeenCalled();
    });

    it('definirCotacaoManual deve chamar serviço e recarregar', async () => {
      await store.definirCotacaoManual(1, 45.0);

      expect(mockService.definirCotacaoManual).toHaveBeenCalledWith(1, 45.0);
      expect(mockService.getPosicoes).toHaveBeenCalled();
    });

    it('converterTicker deve chamar serviço e recarregar', async () => {
      const payload: ConversaoTickerDto = { novo_ticker: 'ISAE4', fator_conversao: 1.0 };
      await store.converterTicker(1, payload);

      expect(mockService.converterTicker).toHaveBeenCalledWith(1, payload);
      expect(mockService.getPosicoes).toHaveBeenCalled();
    });

    it('excluirAtivo deve chamar serviço, recarregar e limpar modal do ativo', async () => {
      store.transacoesAtivoModal.set([
        {
          id: 10,
          ativo_id: 1,
          data_hora: '2026-01-10T10:00:00Z',
          tipo_operacao: 'BUY',
          quantidade: 100,
          preco_unitario: 1.0,
          taxas: 0,
          moeda: 'BRL',
        },
      ]);

      await store.excluirAtivo(1);

      expect(mockService.excluirAtivo).toHaveBeenCalledWith(1);
      expect(mockService.getPosicoes).toHaveBeenCalled();
      expect(store.transacoesAtivoModal().length).toBe(0);
    });

    it('carregarTransacoesAtivo deve atualizar signal transacoesAtivoModal', async () => {
      const fakeTxs: Transacao[] = [
        {
          id: 1,
          ativo_id: 1,
          data_hora: '2026-01-10T10:00:00Z',
          tipo_operacao: 'BUY',
          quantidade: 100,
          preco_unitario: 30,
          taxas: 0,
          moeda: 'BRL',
        },
      ];
      mockService.listarTransacoes.and.returnValue(of(fakeTxs));

      await store.carregarTransacoesAtivo(1);

      expect(mockService.listarTransacoes).toHaveBeenCalledWith({ carteiraId: 1, ativoId: 1 });
      expect(store.transacoesAtivoModal().length).toBe(1);
    });

    it('criarTransacao deve chamar serviço, recarregar e atualizar transacoesAtivoModal', async () => {
      const existingTx: Transacao = {
        id: 1,
        ativo_id: 1,
        data_hora: '2026-01-10T10:00:00Z',
        tipo_operacao: 'BUY',
        quantidade: 100,
        preco_unitario: 30,
        taxas: 0,
        moeda: 'BRL',
      };
      store.transacoesAtivoModal.set([existingTx]);

      const payload: TransacaoCreateDto = {
        carteira_id: 1,
        ativo_id: 1,
        tipo_operacao: 'DIVIDENDO',
        quantidade: 100,
        preco_unitario: 1.25,
      };
      const createdTx: Transacao = {
        id: 2,
        ativo_id: 1,
        carteira_id: 1,
        data_hora: '2026-02-01T10:00:00Z',
        tipo_operacao: 'DIVIDENDO',
        quantidade: 100,
        preco_unitario: 1.25,
        taxas: 0,
        moeda: 'BRL',
      };
      mockService.criarTransacao.and.returnValue(of(createdTx));

      await store.criarTransacao(payload);

      expect(mockService.criarTransacao).toHaveBeenCalledWith(payload);
      expect(mockService.getPosicoes).toHaveBeenCalled();
      expect(store.transacoesAtivoModal().length).toBe(2);
      expect(store.transacoesAtivoModal()[0].id).toBe(2);
    });

    it('atualizarTransacao deve chamar serviço, recarregar e atualizar modal', async () => {
      const existingTx: Transacao = {
        id: 10,
        ativo_id: 1,
        data_hora: '2026-01-10T10:00:00Z',
        tipo_operacao: 'BUY',
        quantidade: 100,
        preco_unitario: 1.0,
        taxas: 0,
        moeda: 'BRL',
      };
      store.transacoesAtivoModal.set([existingTx]);

      const payload: TransacaoUpdateDto = { preco_unitario: 1.5 };
      mockService.atualizarTransacao.and.returnValue(
        of({ ...existingTx, preco_unitario: 1.5 }),
      );

      await store.atualizarTransacao(10, payload);

      expect(mockService.atualizarTransacao).toHaveBeenCalledWith(10, payload);
      expect(mockService.getPosicoes).toHaveBeenCalled();
      expect(store.transacoesAtivoModal()[0].preco_unitario).toBe(1.5);
    });

    it('excluirTransacao deve chamar serviço, recarregar e remover transação do modal', async () => {
      const existingTx: Transacao = {
        id: 10,
        ativo_id: 1,
        data_hora: '2026-01-10T10:00:00Z',
        tipo_operacao: 'BUY',
        quantidade: 100,
        preco_unitario: 1.0,
        taxas: 0,
        moeda: 'BRL',
      };
      store.transacoesAtivoModal.set([existingTx]);

      await store.excluirTransacao(10);

      expect(mockService.excluirTransacao).toHaveBeenCalledWith(10);
      expect(mockService.getPosicoes).toHaveBeenCalled();
      expect(store.transacoesAtivoModal().length).toBe(0);
    });

    it('posicoesFiltradasEncerradas deve incluir ativos com saldo zero que possuem histórico', async () => {
      await store.carregarDados(1, false);

      const encerradas = store.posicoesFiltradasEncerradas();
      const bbas3 = encerradas.find((p) => p.ativo.ticker === 'BBAS3');

      expect(bbas3).toBeDefined();
      expect(bbas3?.quantidade).toBe(0);
      expect(bbas3?.lucroRealizadoBrl).toBe(1200);
      expect(bbas3?.proventosTotal).toBe(500);
    });

    it('posicoesFiltradasEncerradas deve incluir cripto com vendas parciais na aba PATRIMONIO e CRIPTO', async () => {
      await store.carregarDados(1, false);

      const criptoParcial: PosicaoConsolidada = {
        id: 999,
        carteira_id: 1,
        ativo_id: 999,
        quantidade_saldo: 20,
        custo_total_brl: 20000,
        preco_medio_brl: 1000,
        proventos_acumulados_brl: 100,
        lucro_realizado_brl: 5000,
        dividendo_por_acao_brl: 5,
        preco_medio_ajustado_brl: 995,
        yoc_acumulado_pct: 0.5,
        data_atualizacao: '2026-10-16T12:00:00Z',
        quantidade_vendida: 40,
        custo_vendas_brl: 40000,
        valor_total_vendas_brl: 45000,
        ativo: {
          id: 999,
          ticker: 'SOL',
          nome: 'Solana',
          tipo: 'Cripto',
          setor: 'Criptoativos',
        },
      };

      mockService.getPosicoes.and.returnValue(of([...mockPosicoes, criptoParcial]));
      await store.carregarDados(1, true);

      // Na aba PATRIMONIO
      store.setFiltroClasse('PATRIMONIO');
      let encerradas = store.posicoesFiltradasEncerradas();
      const solPatrimonio = encerradas.find((p) => p.ativo.ticker === 'SOL');
      expect(solPatrimonio).toBeDefined();
      expect(solPatrimonio?.custoVendasBrl).toBe(40000);
      expect(solPatrimonio?.valorTotalVendasBrl).toBe(45000);

      // Na aba CRIPTO
      store.setFiltroClasse('CRIPTO');
      encerradas = store.posicoesFiltradasEncerradas();
      const solCripto = encerradas.find((p) => p.ativo.ticker === 'SOL');
      expect(solCripto).toBeDefined();
    });

    it('setVisaoCustodia deve atualizar visaoCustodia', () => {
      expect(store.visaoCustodia()).toBe('ATIVAS');

      store.setVisaoCustodia('ENCERRADAS');
      expect(store.visaoCustodia()).toBe('ENCERRADAS');

      store.setVisaoCustodia('ATIVAS');
      expect(store.visaoCustodia()).toBe('ATIVAS');
    });

    it('posicoesEnriquecidas deve mapear quantidadeSemCusto e lotesPendentes', async () => {
      await store.carregarDados(1, false);

      const todas = store.posicoesEnriquecidas();
      expect(todas.length).toBeGreaterThan(0);
      for (const p of todas) {
        expect(p.quantidadeSemCusto).toBeDefined();
        expect(Array.isArray(p.lotesPendentes)).toBeTrue();
      }
    });

    it('posicoesEnriquecidas deve manter custoTotal = 0 para posição encerrada com custo pendente e lucro realizado zero', () => {
      const posEncerradaPendente: PosicaoConsolidada = {
        id: 777,
        carteira_id: 1,
        ativo_id: 777,
        quantidade_saldo: 0,
        custo_total_brl: 0,
        preco_medio_brl: 0,
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 0,
        yoc_acumulado_pct: 0,
        quantidade_sem_custo: 200,
        custo_pendente: true,
        valor_total_venda_brl: 5000,
        lotes_pendentes: [
          {
            transacao_id: 1,
            data: '2022-03-23',
            quantidade: 200,
          },
        ],
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: { id: 777, ticker: 'ITUB4', nome: 'Itaú Unibanco', tipo: 'Acao' },
      };

      store.todasPosicoes.set([posEncerradaPendente]);
      const enriquecida = store.posicoesEnriquecidas()[0];

      expect(enriquecida.quantidade).toBe(0);
      expect(enriquecida.custoPendente).toBeTrue();
      expect(enriquecida.lucroRealizadoBrl).toBe(0);
      expect(enriquecida.valorTotalVendaBrl).toBe(5000);
      expect(enriquecida.custoTotal).toBe(0);
    });

    it('deve preservar custoTotal em CDB encerrado por vencimento (venda = 25000, lucro = 0)', () => {
      const posCdbVencido: PosicaoConsolidada = {
        id: 888,
        carteira_id: 1,
        ativo_id: 888,
        quantidade_saldo: 0,
        custo_total_brl: 0,
        preco_medio_brl: 0,
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 0,
        yoc_acumulado_pct: 0,
        quantidade_sem_custo: 0,
        custo_pendente: false,
        valor_total_venda_brl: 25000,
        custo_historico_brl: 25000,
        lotes_pendentes: [],
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: { id: 888, ticker: 'CDB-CDBTEST01', nome: 'CDB CDBTEST01', tipo: 'RendaFixa' },
      };

      store.todasPosicoes.set([posCdbVencido]);
      const enriquecida = store.posicoesEnriquecidas()[0];

      expect(enriquecida.quantidade).toBe(0);
      expect(enriquecida.lucroRealizadoBrl).toBe(0);
      expect(enriquecida.valorTotalVendaBrl).toBe(25000);
      expect(enriquecida.custoTotal).toBe(25000);
    });

    it('deve exibir custo histórico quando valorTotalVenda == 0 e lucroRealizado == 0', () => {
      const posCdbZero: PosicaoConsolidada = {
        id: 889,
        carteira_id: 1,
        ativo_id: 889,
        quantidade_saldo: 0,
        custo_total_brl: 0,
        preco_medio_brl: 0,
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: 0,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 0,
        yoc_acumulado_pct: 0,
        quantidade_sem_custo: 0,
        custo_pendente: false,
        valor_total_venda_brl: 0,
        custo_historico_brl: 25000,
        lotes_pendentes: [],
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: { id: 889, ticker: 'CDB-CDBTEST01', nome: 'CDB CDBTEST01', tipo: 'RendaFixa' },
      };

      store.todasPosicoes.set([posCdbZero]);
      const enriquecida = store.posicoesEnriquecidas()[0];

      expect(enriquecida.quantidade).toBe(0);
      expect(enriquecida.custoTotal).toBe(25000);
    });

    it('deve apurar custoTotal quando valorTotalVenda == 0 e lucroRealizado < 0', () => {
      const posComPrejuizo: PosicaoConsolidada = {
        id: 890,
        carteira_id: 1,
        ativo_id: 890,
        quantidade_saldo: 0,
        custo_total_brl: 0,
        preco_medio_brl: 0,
        proventos_acumulados_brl: 0,
        lucro_realizado_brl: -25000,
        dividendo_por_acao_brl: 0,
        preco_medio_ajustado_brl: 0,
        yoc_acumulado_pct: 0,
        quantidade_sem_custo: 0,
        custo_pendente: false,
        valor_total_venda_brl: 0,
        custo_historico_brl: 25000,
        lotes_pendentes: [],
        data_atualizacao: '2026-10-16T12:00:00Z',
        ativo: { id: 890, ticker: 'CDB-TESTE', nome: 'CDB Teste', tipo: 'RendaFixa' },
      };

      store.todasPosicoes.set([posComPrejuizo]);
      const enriquecida = store.posicoesEnriquecidas()[0];

      expect(enriquecida.quantidade).toBe(0);
      expect(enriquecida.lucroRealizadoBrl).toBe(-25000);
      expect(enriquecida.custoTotal).toBe(25000);
    });
  });

  describe('proventosAnuaisCustodiaFiltrados', () => {
    it('deve filtrar apenas ativos em custódia ativa (saldo > 0) e respeitar o filtro de classe', async () => {
      await store.carregarDados(1);

      // Default RV_TOTAL: PETR4 (Ação) e HGLG11 (FII) estão em custódia e têm proventos. BBAS3 tem saldo 0 e deve ser excluída.
      store.setFiltroClasse('RV_TOTAL');
      let ativosCustodia = store.proventosAnuaisCustodiaFiltrados();
      expect(ativosCustodia.length).toBe(2);
      expect(ativosCustodia.map((a) => a.ticker)).toEqual(['PETR4', 'HGLG11']);

      // Filtro ACAO: apenas PETR4
      store.setFiltroClasse('ACAO');
      ativosCustodia = store.proventosAnuaisCustodiaFiltrados();
      expect(ativosCustodia.length).toBe(1);
      expect(ativosCustodia[0].ticker).toBe('PETR4');
      expect(ativosCustodia[0].pct_dividendo_total).toBe(66.67);
      expect(ativosCustodia[0].pct_jcp_total).toBe(33.33);

      // Filtro FII: apenas HGLG11
      store.setFiltroClasse('FII');
      ativosCustodia = store.proventosAnuaisCustodiaFiltrados();
      expect(ativosCustodia.length).toBe(1);
      expect(ativosCustodia[0].ticker).toBe('HGLG11');
    });
  });
});

