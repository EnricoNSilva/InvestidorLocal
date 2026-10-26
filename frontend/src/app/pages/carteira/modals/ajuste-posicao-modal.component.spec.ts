import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { AjustePosicaoModalComponent } from './ajuste-posicao-modal.component';
import { CarteiraStore } from '../state/carteira.store';
import { CarteiraService } from '../../../core/services/carteira.service';
import { PosicaoEnriquecida } from '../../../core/models/investimento.models';

describe('AjustePosicaoModalComponent', () => {
  let fixture: ComponentFixture<AjustePosicaoModalComponent>;
  let component: AjustePosicaoModalComponent;
  let componentRef: ComponentRef<AjustePosicaoModalComponent>;
  let store: CarteiraStore;
  let carteiraService: jasmine.SpyObj<CarteiraService>;

  const fakePosicao: PosicaoEnriquecida = {
    posicao: {
      id: 10,
      carteira_id: 1,
      ativo_id: 5,
      quantidade_saldo: 100,
      custo_total_brl: 3000,
      preco_medio_brl: 30,
      proventos_acumulados_brl: 200,
      lucro_realizado_brl: 0,
      dividendo_por_acao_brl: 2,
      preco_medio_ajustado_brl: 28,
      yoc_acumulado_pct: 6.67,
      data_atualizacao: new Date().toISOString(),
    },
    ativo: {
      id: 5,
      ticker: 'TRPL4',
      nome: 'Transmissão Paulista',
      tipo: 'Acao',
      setor: 'Energia Elétrica',
      cotacao_manual: 25.5,
    },
    quantidade: 100,
    pmContabil: 30,
    custoTotal: 3000,
    custoPendente: false,
    quantidadeSemCusto: 0,
    lotesPendentes: [],
    proventosTotal: 200,
    dividendoPorAcao: 2,
    pmAjustado: 28,
    cotacaoAtual: 25.5,
    fonteCotacao: 'MANUAL',
    variacaoDiariaPct: 0,
    valorMercado: 2550,
    lucroNaoRealizadoBrl: -450,
    rentabCotaPct: -15,
    retornoTotalBrl: -250,
    rentabTotalComDivPct: -8.33,
    yocPct: 6.67,
    lucroRealizadoBrl: 0,
    pesoCarteiraPct: 100,
  };

  beforeEach(async () => {
    const spyService = jasmine.createSpyObj('CarteiraService', [
      'ajustarPosicaoManual',
      'converterTicker',
      'getPosicoes',
      'obterCotacoes',
      'obterCotacaoHistorica',
      'obterProventosAnuais',
    ]);
    spyService.carteiraAtivaId = jasmine.createSpy('carteiraAtivaId').and.returnValue(1);
    spyService.ajustarPosicaoManual.and.returnValue(of(fakePosicao.posicao));
    spyService.converterTicker.and.returnValue(of(fakePosicao.ativo));
    spyService.obterCotacaoHistorica.and.returnValue(
      of({ ticker: 'TRPL4', data: '2022-03-23', cotacao_fechamento: 24.5 }),
    );
    spyService.getPosicoes.and.returnValue(of([fakePosicao.posicao]));
    spyService.obterCotacoes.and.returnValue(
      of({ carteira_id: 1, atualizado_em: '', stale: false, cotacoes: {} }),
    );
    spyService.obterProventosAnuais.and.returnValue(of({ carteira_id: 1, ativos: [] }));

    await TestBed.configureTestingModule({
      imports: [AjustePosicaoModalComponent],
      providers: [
        CarteiraStore,
        { provide: CarteiraService, useValue: spyService },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    store = TestBed.inject(CarteiraStore);
    carteiraService = TestBed.inject(CarteiraService) as jasmine.SpyObj<CarteiraService>;

    fixture = TestBed.createComponent(AjustePosicaoModalComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;

    componentRef.setInput('isOpen', true);
    componentRef.setInput('posicao', fakePosicao);
    fixture.detectChanges();
  });

  it('deve inicializar campos com valores da posicao incluindo ticker', () => {
    expect(component.tickerAtivo).toBe('TRPL4');
    expect(component.nomeAtivo).toBe('Transmissão Paulista');
    expect(component.quantidade).toBe(100);
    expect(component.precoMedio).toBe(30);
    expect(component.proventosAcumulados).toBe(200);
    expect(component.cotacaoManual).toBe(25.5);
  });

  it('deve alternar a seção de conversão de ticker', () => {
    expect(component.secaoConversaoAberta()).toBeFalse();
    component.toggleSecaoConversao();
    expect(component.secaoConversaoAberta()).toBeTrue();
  });

  it('deve chamar ajustarPosicaoManual do store com ticker e valores ao salvar', async () => {
    spyOn(store, 'ajustarPosicaoManual').and.returnValue(Promise.resolve());
    spyOn(component.salvo, 'emit');
    spyOn(component.fechar, 'emit');

    component.tickerAtivo = 'TRPL4';
    component.precoMedio = 32.5;
    await component.salvarAjuste();

    expect(store.ajustarPosicaoManual).toHaveBeenCalledWith(
      5,
      jasmine.objectContaining({
        ticker: 'TRPL4',
        preco_medio_brl: 32.5,
        quantidade_saldo: 100,
        cotacao_manual: 25.5,
      }),
    );
    expect(component.salvo.emit).toHaveBeenCalled();
    expect(component.fechar.emit).toHaveBeenCalled();
  });

  it('deve enviar cotacao_manual como null quando campo for limpo ou zerado', async () => {
    spyOn(store, 'ajustarPosicaoManual').and.returnValue(Promise.resolve());

    component.cotacaoManual = null;
    await component.salvarAjuste();

    expect(store.ajustarPosicaoManual).toHaveBeenCalledWith(
      5,
      jasmine.objectContaining({
        cotacao_manual: null,
      }),
    );
  });

  it('não deve salvar se o ticker estiver vazio', async () => {
    spyOn(store, 'ajustarPosicaoManual');

    component.tickerAtivo = '   ';
    await component.salvarAjuste();

    expect(store.ajustarPosicaoManual).not.toHaveBeenCalled();
    expect(component.erro()).toBe('O ticker é obrigatório.');
  });

  it('deve chamar converterTicker do store na conversão', async () => {
    spyOn(store, 'converterTicker').and.returnValue(Promise.resolve());
    spyOn(component.salvo, 'emit');
    spyOn(component.fechar, 'emit');

    component.novoTicker = 'ISAE4';
    component.fatorConversao = 1.0;
    await component.executarConversaoTicker();

    expect(store.converterTicker).toHaveBeenCalledWith(
      5,
      jasmine.objectContaining({
        novo_ticker: 'ISAE4',
        fator_conversao: 1.0,
      }),
    );
    expect(component.salvo.emit).toHaveBeenCalled();
    expect(component.fechar.emit).toHaveBeenCalled();
  });

  it('Modo C: deve buscar cotação histórica e preencher precoUnitarioTransf', async () => {
    await component.buscarCotacaoHistorica({
      transacao_id: 10,
      data: '2022-03-23',
      quantidade: 100,
    });

    expect(carteiraService.obterCotacaoHistorica).toHaveBeenCalledWith(5, '2022-03-23');
    expect(component.precoUnitarioTransf).toBe(24.5);
    expect(component.mensagemCotacaoHistorica()).toContain('24.50');
  });

  it('Modo A: deve chamar ajustarPosicaoManual com preco_unitario_transferencia', async () => {
    spyOn(store, 'ajustarPosicaoManual').and.returnValue(Promise.resolve());
    spyOn(component.salvo, 'emit');
    spyOn(component.fechar, 'emit');

    component.precoUnitarioTransf = 24.5;
    await component.aplicarModoA({
      transacao_id: 10,
      data: '2022-03-23',
      quantidade: 100,
    });

    expect(store.ajustarPosicaoManual).toHaveBeenCalledWith(
      5,
      jasmine.objectContaining({
        transacao_id: 10,
        preco_unitario_transferencia: 24.5,
      }),
    );
    expect(component.salvo.emit).toHaveBeenCalled();
    expect(component.fechar.emit).toHaveBeenCalled();
  });

  it('Modo B: deve chamar ajustarPosicaoManual com pm_consolidado_atual', async () => {
    spyOn(store, 'ajustarPosicaoManual').and.returnValue(Promise.resolve());
    spyOn(component.salvo, 'emit');
    spyOn(component.fechar, 'emit');

    component.pmConsolidadoAtual = 26.8;
    await component.aplicarModoB({
      transacao_id: 10,
      data: '2022-03-23',
      quantidade: 100,
    });

    expect(store.ajustarPosicaoManual).toHaveBeenCalledWith(
      5,
      jasmine.objectContaining({
        transacao_id: 10,
        pm_consolidado_atual: 26.8,
      }),
    );
    expect(component.salvo.emit).toHaveBeenCalled();
    expect(component.fechar.emit).toHaveBeenCalled();
  });

  it('salvarAjuste deve rotear automaticamente para Modo B quando pmConsolidadoAtual estiver preenchido', async () => {
    spyOn(component, 'aplicarModoB').and.returnValue(Promise.resolve());

    component.pmConsolidadoAtual = 28.5;
    await component.salvarAjuste();

    expect(component.aplicarModoB).toHaveBeenCalled();
  });

  it('salvarAjuste deve rotear automaticamente para Modo A quando precoUnitarioTransf estiver preenchido', async () => {
    spyOn(component, 'aplicarModoA').and.returnValue(Promise.resolve());

    component.precoUnitarioTransf = 15.0;
    await component.salvarAjuste();

    expect(component.aplicarModoA).toHaveBeenCalled();
  });
});
