import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { CarteiraComponent } from './carteira.component';
import { CarteiraStore, FILTRO_CLASSE_STORAGE_KEY } from './state/carteira.store';
import { CarteiraService } from '../../core/services/carteira.service';
import { MODAL_DRAFT_STORAGE_KEY, OperacaoDraft } from './modals/nova-operacao-modal.component';
import {
  Carteira,
  CotacoesCarteiraResponse,
  PosicaoConsolidada,
} from '../../core/models/investimento.models';

describe('CarteiraComponent', () => {
  let fixture: ComponentFixture<CarteiraComponent>;
  let component: CarteiraComponent;
  let store: CarteiraStore;
  let carteiraService: jasmine.SpyObj<CarteiraService>;

  const fakeCarteira: Carteira = {
    id: 1,
    nome: 'Carteira Principal',
    descricao: 'Estratégia de Dividendos e Crescimento',
  };

  const fakePosicoes: PosicaoConsolidada[] = [
    {
      id: 101,
      carteira_id: 1,
      ativo_id: 1,
      quantidade_saldo: 100,
      custo_total_brl: 3000,
      preco_medio_brl: 30,
      proventos_acumulados_brl: 250,
      lucro_realizado_brl: 100,
      dividendo_por_acao_brl: 2.5,
      preco_medio_ajustado_brl: 27.5,
      yoc_acumulado_pct: 8.33,
      data_atualizacao: new Date().toISOString(),
      ativo: {
        id: 1,
        ticker: 'PETR4',
        nome: 'Petrobras PN',
        tipo: 'Acao',
        setor: 'Petróleo e Gás',
        cotacao_manual: null,
      },
    },
    {
      id: 102,
      carteira_id: 1,
      ativo_id: 2,
      quantidade_saldo: 50,
      custo_total_brl: 0,
      preco_medio_brl: 0, // Custo pendente!
      proventos_acumulados_brl: 50,
      lucro_realizado_brl: 0,
      dividendo_por_acao_brl: 1,
      preco_medio_ajustado_brl: 0,
      yoc_acumulado_pct: 0,
      data_atualizacao: new Date().toISOString(),
      ativo: {
        id: 2,
        ticker: 'MXRF11',
        nome: 'Maxi Renda FII',
        tipo: 'FII',
        setor: 'Híbrido',
        cotacao_manual: null,
      },
    },
    {
      id: 103,
      carteira_id: 1,
      ativo_id: 3,
      quantidade_saldo: 0.1,
      custo_total_brl: 40000,
      preco_medio_brl: 400000,
      proventos_acumulados_brl: 0,
      lucro_realizado_brl: 0,
      dividendo_por_acao_brl: 0,
      preco_medio_ajustado_brl: 400000,
      yoc_acumulado_pct: 0,
      data_atualizacao: new Date().toISOString(),
      ativo: {
        id: 3,
        ticker: 'BTC',
        nome: 'Bitcoin',
        tipo: 'Cripto',
        setor: 'Criptoativos',
        cotacao_manual: null,
      },
    },
  ];

  const fakeCotacoes: CotacoesCarteiraResponse = {
    carteira_id: 1,
    atualizado_em: '2026-10-16T15:00:00Z',
    stale: false,
    cotacoes: {
      PETR4: {
        ticker: 'PETR4',
        preco_atual: 35,
        variacao_diaria_pct: 1.5,
        fonte: 'YAHOO',
        atualizado_em: '2026-10-16T15:00:00Z',
        stale: false,
      },
      MXRF11: {
        ticker: 'MXRF11',
        preco_atual: 10.5,
        variacao_diaria_pct: 0.2,
        fonte: 'YAHOO',
        atualizado_em: '2026-10-16T15:00:00Z',
        stale: false,
      },
      BTC: {
        ticker: 'BTC',
        preco_atual: 500000,
        variacao_diaria_pct: 3.0,
        fonte: 'YAHOO',
        atualizado_em: '2026-10-16T15:00:00Z',
        stale: false,
      },
    },
  };

  beforeEach(async () => {
    localStorage.removeItem(FILTRO_CLASSE_STORAGE_KEY);
    localStorage.removeItem(MODAL_DRAFT_STORAGE_KEY);

    const spyService = jasmine.createSpyObj('CarteiraService', [
      'getPosicoes',
      'obterCotacoes',
      'recalcularCarteira',
      'ajustarPosicaoManual',
      'converterTicker',
      'listarTransacoes',
      'criarTransacao',
      'atualizarTransacao',
      'excluirTransacao',
      'excluirAtivo',
      'criarAtivo',
      'criarCarteira',
      'excluirCarteira',
      'limparCarteira',
      'selecionarCarteira',
    ]);

    spyService.carteiraAtivaId = jasmine.createSpy('carteiraAtivaId').and.returnValue(1);
    spyService.carteiras = jasmine.createSpy('carteiras').and.returnValue([fakeCarteira]);
    spyService.getPosicoes.and.returnValue(of(fakePosicoes));
    spyService.obterCotacoes.and.returnValue(of(fakeCotacoes));
    spyService.recalcularCarteira.and.returnValue(of({}));
    spyService.ajustarPosicaoManual.and.returnValue(of({}));
    spyService.converterTicker.and.returnValue(of({}));
    spyService.listarTransacoes.and.returnValue(of([]));
    spyService.criarTransacao.and.returnValue(of({}));
    spyService.atualizarTransacao.and.returnValue(of({}));
    spyService.excluirTransacao.and.returnValue(of({}));
    spyService.excluirAtivo.and.returnValue(of({}));
    spyService.criarAtivo.and.returnValue(of({ id: 99, ticker: 'NOVO4', nome: 'Novo Ativo', tipo: 'Acao' }));
    spyService.criarCarteira.and.returnValue(of({ id: 2, nome: 'Nova' }));
    spyService.excluirCarteira.and.returnValue(of({}));
    spyService.limparCarteira.and.returnValue(of({}));

    await TestBed.configureTestingModule({
      imports: [CarteiraComponent],
      providers: [
        CarteiraStore,
        { provide: CarteiraService, useValue: spyService },
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();

    store = TestBed.inject(CarteiraStore);
    carteiraService = TestBed.inject(CarteiraService) as jasmine.SpyObj<CarteiraService>;

    // Popula o store diretamente
    store.todasPosicoes.set(fakePosicoes);
    store.cotacoesMap.set(fakeCotacoes.cotacoes);
    store.cotacoesMeta.set({ atualizadoEm: fakeCotacoes.atualizado_em, stale: false });
    store.loading.set(false);

    fixture = TestBed.createComponent(CarteiraComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem(FILTRO_CLASSE_STORAGE_KEY);
    localStorage.removeItem(MODAL_DRAFT_STORAGE_KEY);
  });

  it('deve instanciar CarteiraComponent corretamente', () => {
    expect(component).toBeTruthy();
    expect(component.carteiraNome()).toBe('Carteira Principal');
  });

  it('deve renderizar inicialmente os 6 KPI cards', () => {
    const kpiCards = fixture.nativeElement.querySelectorAll('.kpi-card');
    expect(kpiCards.length).toBe(6);

    const montanteAportado = kpiCards[0].textContent;
    expect(montanteAportado).toContain('Montante Aportado');

    const patrimonioMercado = kpiCards[1].textContent;
    expect(patrimonioMercado).toContain('Patrimônio Atual a Mercado');

    const valorizacao = kpiCards[2].textContent;
    expect(valorizacao).toContain('Valorização da Cota');

    const proventos = kpiCards[3].textContent;
    expect(proventos).toContain('Proventos Recebidos');

    const retornoTotal = kpiCards[4].textContent;
    expect(retornoTotal).toContain('Retorno Total Acumulado');

    const realizado = kpiCards[5].textContent;
    expect(realizado).toContain('Lucro / Prejuízo Realizado');
  });

  it('deve alternar abas de classe chamando o store', () => {
    expect(store.filtroClasse()).toBe('RV_TOTAL');

    // Troca para Somente Ações
    component.selecionarAbaClasse('ACAO');
    fixture.detectChanges();
    expect(store.filtroClasse()).toBe('ACAO');
    expect(component.posicoesTabela().every((p) => p.ativo.tipo === 'Acao')).toBeTrue();

    // Troca para Somente FIIs
    component.selecionarAbaClasse('FII');
    fixture.detectChanges();
    expect(store.filtroClasse()).toBe('FII');
    expect(component.posicoesTabela().every((p) => p.ativo.tipo === 'FII')).toBeTrue();

    // Troca para Patrimônio Total
    component.selecionarAbaClasse('PATRIMONIO');
    fixture.detectChanges();
    expect(store.filtroClasse()).toBe('PATRIMONIO');
    expect(component.posicoesTabela().length).toBe(3);
  });

  it('deve exibir botão destacado "⚠️ Definir PM" para ativos com custo pendente e abrir Modal 1 ao clicar', () => {
    // Aba RV_TOTAL contém MXRF11 com PM = 0
    fixture.detectChanges();

    const botoesDefinirPm = fixture.nativeElement.querySelectorAll('.btn-definir-pm');
    expect(botoesDefinirPm.length).toBeGreaterThan(0);
    expect(botoesDefinirPm[0].textContent).toContain('Definir PM');

    // Clica no botão
    botoesDefinirPm[0].click();
    fixture.detectChanges();

    expect(component.modalAjusteAberto()).toBeTrue();
    expect(component.ativoParaAjuste()?.ativo.ticker).toBe('MXRF11');
  });

  it('clique no backdrop (.modal-overlay) NÃO deve fechar nenhum modal (Proteção Estrita de UX)', () => {
    // 1. Abre Modal de Ajuste
    const mxrf11 = component.posicoesTabela().find((p) => p.ativo.ticker === 'MXRF11')!;
    component.abrirModalAjuste(mxrf11);
    fixture.detectChanges();
    expect(component.modalAjusteAberto()).toBeTrue();

    // Simula clique no backdrop
    const modalAjusteEl = fixture.nativeElement.querySelector('app-ajuste-posicao-modal');
    const overlayAjuste = modalAjusteEl.querySelector('.modal-overlay');
    expect(overlayAjuste).toBeTruthy();

    overlayAjuste.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    // O modal deve continuar aberto!
    expect(component.modalAjusteAberto()).toBeTrue();

    // Fecha pelo método/botão oficial
    component.fecharModalAjuste();
    fixture.detectChanges();
    expect(component.modalAjusteAberto()).toBeFalse();

    // 2. Abre Modal de Nova Operação
    component.abrirModalNovaOperacao();
    fixture.detectChanges();
    expect(component.modalNovaOperacaoAberto()).toBeTrue();

    const modalOpEl = fixture.nativeElement.querySelector('app-nova-operacao-modal');
    const overlayOp = modalOpEl.querySelector('.modal-overlay');
    expect(overlayOp).toBeTruthy();

    overlayOp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    // Permanece aberto!
    expect(component.modalNovaOperacaoAberto()).toBeTrue();
  });

  it('deve persistir e restaurar rascunho de operação no localStorage com suporte a limpar campos', () => {
    const draft: OperacaoDraft = {
      modoNovoAtivo: false,
      ativoSelecionadoId: 1,
      novoTicker: '',
      novoNome: '',
      novoTipo: 'Acao',
      novoSetor: '',
      tipoOperacao: 'BUY',
      dataOperacao: '2026-10-16',
      quantidade: 50,
      precoUnitario: 34.5,
      taxas: 4.8,
    };

    localStorage.setItem(MODAL_DRAFT_STORAGE_KEY, JSON.stringify(draft));

    // Abre o modal de nova operação
    component.abrirModalNovaOperacao();
    fixture.detectChanges();

    const modalOpEl = fixture.nativeElement.querySelector('app-nova-operacao-modal');
    expect(modalOpEl).toBeTruthy();

    // Verifica que o rascunho foi recuperado
    const hint = modalOpEl.querySelector('.draft-hint');
    expect(hint).toBeTruthy();
    expect(hint.textContent).toContain('Rascunho anterior recuperado');

    // Clica em "Limpar Campos"
    const btnLimpar = modalOpEl.querySelector('.btn-limpar');
    expect(btnLimpar).toBeTruthy();
    btnLimpar.click();
    fixture.detectChanges();

    // localStorage deve estar limpo
    expect(localStorage.getItem(MODAL_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('deve filtrar ativos com custo pendente ao clicar no badge do Card 1', () => {
    expect(component.filtrarApenasCustoPendente()).toBeFalse();

    const badgeAlerta = fixture.nativeElement.querySelector('.badge-alerta-custo');
    expect(badgeAlerta).toBeTruthy();
    expect(badgeAlerta.textContent).toContain('1 com PM a definir');

    // Clica no badge
    badgeAlerta.click();
    fixture.detectChanges();

    expect(component.filtrarApenasCustoPendente()).toBeTrue();
    expect(component.posicoesTabela().length).toBe(1);
    expect(component.posicoesTabela()[0].ativo.ticker).toBe('MXRF11');

    // Desativa o filtro
    component.toggleFiltroCustoPendente();
    fixture.detectChanges();
    expect(component.filtrarApenasCustoPendente()).toBeFalse();
  });

  it('deve chamar atualizarCotacoes e recalcularCarteira ao clicar nos botões de ação', () => {
    spyOn(store, 'atualizarCotacoes');
    spyOn(store, 'recalcular');

    component.atualizarCotacoes();
    expect(store.atualizarCotacoes).toHaveBeenCalledWith(true);

    component.recalcularCarteira();
    expect(store.recalcular).toHaveBeenCalled();
  });

  it('deve disparar ordenação ao clicar nos cabeçalhos da tabela', () => {
    spyOn(store, 'setOrdenacao');

    component.ordenarPor('yocPct');
    expect(store.setOrdenacao).toHaveBeenCalledWith('yocPct');

    component.ordenarPor('pmAjustado');
    expect(store.setOrdenacao).toHaveBeenCalledWith('pmAjustado');
  });

  it('deve abrir Modal 2 (Histórico) ao clicar no botão de histórico', () => {
    const petr4 = component.posicoesTabela().find((p) => p.ativo.ticker === 'PETR4')!;
    component.abrirModalHistorico(petr4);
    fixture.detectChanges();

    expect(component.modalHistoricoAberto()).toBeTrue();
    expect(component.ativoParaHistorico()?.ativo.ticker).toBe('PETR4');

    component.fecharModalHistorico();
    expect(component.modalHistoricoAberto()).toBeFalse();
  });

  it('deve excluir ativo com confirmação chamando store.excluirAtivo', () => {
    spyOn(window, 'confirm').and.returnValue(true);
    spyOn(store, 'excluirAtivo').and.returnValue(Promise.resolve());

    const petr4 = component.posicoesTabela().find((p) => p.ativo.ticker === 'PETR4')!;
    component.confirmarExcluirAtivo(petr4);

    expect(window.confirm).toHaveBeenCalled();
    expect(store.excluirAtivo).toHaveBeenCalledWith(1);
  });

  it('deve alternar visão de custódia entre ATIVAS e ENCERRADAS', () => {
    expect(store.visaoCustodia()).toBe('ATIVAS');

    component.selecionarVisaoCustodia('ENCERRADAS');
    expect(store.visaoCustodia()).toBe('ENCERRADAS');

    component.selecionarVisaoCustodia('ATIVAS');
    expect(store.visaoCustodia()).toBe('ATIVAS');
  });

  it('deve formatar data do primeiro lote pendente com getDataPrimeiroLote', () => {
    const posComLote = {
      ...component.posicoesTabela()[0],
      lotesPendentes: [
        {
          transacao_id: 1,
          data: '2022-03-23',
          quantidade: 500,
        },
      ],
    };
    expect(component.getDataPrimeiroLote(posComLote)).toBe('23/03/2022');

    const posSemLote = {
      ...component.posicoesTabela()[0],
      lotesPendentes: [],
    };
    expect(component.getDataPrimeiroLote(posSemLote)).toBe('23/03/2022');
  });

  it('deve exibir toast e destacar linha quando onPosicaoSalva for disparado', () => {
    component.onPosicaoSalva({
      ativoId: 1,
      ticker: 'PETR4',
      mensagem: 'PETR4 atualizado com sucesso!',
    });
    fixture.detectChanges();

    expect(component.toastSucesso()).toBe('PETR4 atualizado com sucesso!');
    expect(component.ultimoAtivoAtualizadoId()).toBe(1);

    component.fecharToast();
    expect(component.toastSucesso()).toBeNull();
  });

  it('deve retornar badge correto para TESOURO e CURVA_CDI em getBadgeCotacao', () => {
    const posTesouro = {
      ...component.posicoesTabela()[0],
      fonteCotacao: 'TESOURO' as const,
    };
    expect(component.getBadgeCotacao(posTesouro)).toEqual({
      text: '🏛️ Tesouro',
      classe: 'quote-tesouro',
    });

    const posCdi = {
      ...component.posicoesTabela()[0],
      fonteCotacao: 'CURVA_CDI' as const,
    };
    expect(component.getBadgeCotacao(posCdi)).toEqual({
      text: '📈 Curva CDI',
      classe: 'quote-cdi',
    });

    const posBinance = {
      ...component.posicoesTabela()[0],
      fonteCotacao: 'BINANCE' as const,
    };
    expect(component.getBadgeCotacao(posBinance)).toEqual({
      text: '🟡 Binance Spot',
      classe: 'quote-binance',
    });
  });

  it('deve retornar badge da Binance em getStatusGeralCotacoes quando filtro for CRIPTO', () => {
    store.setFiltroClasse('CRIPTO');
    fixture.detectChanges();
    const status = component.getStatusGeralCotacoes();
    expect(status.text).toBe('🟡 Binance API');
    expect(status.classe).toBe('quote-binance');
  });

  it('deve formatar valores em USD corretamente com formatarUsd', () => {
    expect(component.formatarUsd(null)).toBe('US$ 0,00');
    expect(component.formatarUsd(156.2597)).toContain('156,26');
    expect(component.formatarUsd(71147.6866)).toContain('71.147,69');
  });

  it('deve disparar toast ao invocar copiarTextoIrpf', async () => {
    const pos = {
      ...component.posicoesTabela()[0],
      codigoRfbIrpf: '08/01',
      textoIrpfBensDireitos: '0.06561877 BTC em custódia',
    };
    if (navigator.clipboard) {
      spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());
    }
    component.copiarTextoIrpf(pos);
    await fixture.whenStable();
    expect(component.toastSucesso()).toContain('08/01');
  });
});

