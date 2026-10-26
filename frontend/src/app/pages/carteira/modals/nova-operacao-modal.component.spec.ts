import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import {
  NovaOperacaoModalComponent,
  MODAL_DRAFT_STORAGE_KEY,
  OperacaoDraft,
} from './nova-operacao-modal.component';
import { CarteiraStore } from '../state/carteira.store';
import { CarteiraService } from '../../../core/services/carteira.service';
import { Ativo } from '../../../core/models/investimento.models';

describe('NovaOperacaoModalComponent', () => {
  let fixture: ComponentFixture<NovaOperacaoModalComponent>;
  let component: NovaOperacaoModalComponent;
  let componentRef: ComponentRef<NovaOperacaoModalComponent>;
  let store: CarteiraStore;
  let carteiraService: jasmine.SpyObj<CarteiraService>;

  const fakeAtivos: Ativo[] = [
    { id: 1, ticker: 'PETR4', nome: 'Petrobras PN', tipo: 'Acao', setor: 'Petróleo' },
    { id: 2, ticker: 'HGLG11', nome: 'CSHG Logística', tipo: 'FII', setor: 'Logística' },
  ];

  beforeEach(async () => {
    localStorage.removeItem(MODAL_DRAFT_STORAGE_KEY);

    const spyService = jasmine.createSpyObj('CarteiraService', [
      'criarAtivo',
      'criarTransacao',
      'getPosicoes',
      'obterCotacoes',
      'obterProventosAnuais',
    ]);
    spyService.carteiraAtivaId = jasmine.createSpy('carteiraAtivaId').and.returnValue(1);
    spyService.criarAtivo.and.returnValue(
      of({ id: 10, ticker: 'VALE3', nome: 'Vale S.A.', tipo: 'Acao', setor: 'Mineração' }),
    );
    spyService.criarTransacao.and.returnValue(of({} as any));
    spyService.getPosicoes.and.returnValue(of([]));
    spyService.obterCotacoes.and.returnValue(
      of({ carteira_id: 1, atualizado_em: '', stale: false, cotacoes: {} }),
    );
    spyService.obterProventosAnuais.and.returnValue(of({ carteira_id: 1, ativos: [] }));

    await TestBed.configureTestingModule({
      imports: [NovaOperacaoModalComponent],
      providers: [
        CarteiraStore,
        { provide: CarteiraService, useValue: spyService },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    store = TestBed.inject(CarteiraStore);
    carteiraService = TestBed.inject(CarteiraService) as jasmine.SpyObj<CarteiraService>;

    fixture = TestBed.createComponent(NovaOperacaoModalComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;

    componentRef.setInput('isOpen', true);
    componentRef.setInput('ativosDisponiveis', fakeAtivos);
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem(MODAL_DRAFT_STORAGE_KEY);
  });

  it('deve inicializar o modal com valores padrão', () => {
    expect(component).toBeTruthy();
    expect(component.tipoOperacao).toBe('BUY');
    expect(component.modoNovoAtivo).toBeFalse();
    expect(component.formularioValido()).toBeFalse();
  });

  it('clique no backdrop (.modal-overlay) NÃO deve fechar o modal', () => {
    spyOn(component.fechar, 'emit');
    const overlay = fixture.nativeElement.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(component.fechar.emit).not.toHaveBeenCalled();
  });

  it('deve validar formulário corretamente para ativo existente', () => {
    component.modoNovoAtivo = false;
    component.ativoSelecionadoId = 1;
    component.quantidade = 100;
    component.precoUnitario = 35;
    component.dataOperacao = '2026-10-16';

    expect(component.formularioValido()).toBeTrue();

    // Quantidade zero ou negativa deve invalidar
    component.quantidade = 0;
    expect(component.formularioValido()).toBeFalse();

    component.quantidade = 100;
    component.precoUnitario = -1;
    expect(component.formularioValido()).toBeFalse();
  });

  it('deve alternar para modo novo ativo e exigir ticker válido', () => {
    component.modoNovoAtivo = true;
    component.novoTicker = '';
    component.quantidade = 100;
    component.precoUnitario = 50;
    component.dataOperacao = '2026-10-16';

    expect(component.formularioValido()).toBeFalse();

    component.novoTicker = 'VALE3';
    expect(component.formularioValido()).toBeTrue();
  });

  it('deve salvar e restaurar rascunho de preenchimento no localStorage', () => {
    component.modoNovoAtivo = false;
    component.ativoSelecionadoId = 2;
    component.tipoOperacao = 'DIVIDENDO';
    component.quantidade = 500;
    component.precoUnitario = 1.1;
    component.taxas = 0;
    component.salvarRascunho();

    const salvoRaw = localStorage.getItem(MODAL_DRAFT_STORAGE_KEY);
    expect(salvoRaw).toBeTruthy();
    const salvo: OperacaoDraft = JSON.parse(salvoRaw!);
    expect(salvo.ativoSelecionadoId).toBe(2);
    expect(salvo.tipoOperacao).toBe('DIVIDENDO');
    expect(salvo.quantidade).toBe(500);

    // Reseta e restaura
    component.resetarCampos();
    expect(component.ativoSelecionadoId).toBeNull();

    component.carregarRascunho();
    expect(component.ativoSelecionadoId).toBe(2);
    expect(component.tipoOperacao).toBe('DIVIDENDO');
    expect(component.rascunhoRecuperado()).toBeTrue();
  });

  it('deve limpar rascunho e resetar campos ao clicar em "Limpar Campos"', () => {
    component.tipoOperacao = 'JCP';
    component.quantidade = 100;
    component.salvarRascunho();
    expect(localStorage.getItem(MODAL_DRAFT_STORAGE_KEY)).toBeTruthy();

    component.limparCampos();

    expect(localStorage.getItem(MODAL_DRAFT_STORAGE_KEY)).toBeNull();
    expect(component.tipoOperacao).toBe('BUY');
    expect(component.quantidade).toBe(0);
    expect(component.rascunhoRecuperado()).toBeFalse();
  });

  it('deve cadastrar transação para ativo existente com sucesso', async () => {
    spyOn(store, 'criarTransacao').and.returnValue(Promise.resolve());
    spyOn(component.salvo, 'emit');
    spyOn(component.fechar, 'emit');

    component.modoNovoAtivo = false;
    component.ativoSelecionadoId = 1;
    component.tipoOperacao = 'BUY';
    component.quantidade = 100;
    component.precoUnitario = 32.5;
    component.taxas = 5;
    component.dataOperacao = '2026-10-16';

    await component.salvar();

    expect(store.criarTransacao).toHaveBeenCalledWith(
      jasmine.objectContaining({
        ativo_id: 1,
        tipo_operacao: 'BUY',
        quantidade: 100,
        preco_unitario: 32.5,
        taxas: 5,
      }),
    );
    expect(component.salvo.emit).toHaveBeenCalled();
    expect(component.fechar.emit).toHaveBeenCalled();
  });

  it('deve criar novo ativo antes da transação quando em modoNovoAtivo', async () => {
    spyOn(store, 'criarTransacao').and.returnValue(Promise.resolve());
    spyOn(component.salvo, 'emit');
    spyOn(component.fechar, 'emit');

    component.modoNovoAtivo = true;
    component.novoTicker = 'VALE3';
    component.novoNome = 'Vale S.A.';
    component.novoTipo = 'Acao';
    component.novoSetor = 'Mineração';
    component.tipoOperacao = 'BUY';
    component.quantidade = 50;
    component.precoUnitario = 60;
    component.dataOperacao = '2026-10-16';

    await component.salvar();

    expect(carteiraService.criarAtivo).toHaveBeenCalledWith({
      ticker: 'VALE3',
      nome: 'Vale S.A.',
      tipo: 'Acao',
      setor: 'Mineração',
    });
    expect(store.criarTransacao).toHaveBeenCalledWith(
      jasmine.objectContaining({
        ativo_id: 10, // ID retornado pelo mock do criarAtivo
        quantidade: 50,
      }),
    );
    expect(component.salvo.emit).toHaveBeenCalled();
    expect(component.fechar.emit).toHaveBeenCalled();
  });

  it('deve exibir mensagem de erro se a criação de ativo falhar', async () => {
    carteiraService.criarAtivo.and.returnValue(throwError(() => ({ error: { detail: 'Ticker duplicado' } })));

    component.modoNovoAtivo = true;
    component.novoTicker = 'DUPLICADO';
    component.quantidade = 10;
    component.precoUnitario = 20;
    component.dataOperacao = '2026-10-16';

    await component.salvar();

    expect(component.erro()).toBe('Ticker duplicado');
    expect(component.salvando()).toBeFalse();
  });

  it('deve identificar tipos de proventos via ehProvento', () => {
    component.tipoOperacao = 'BUY';
    expect(component.ehProvento()).toBeFalse();

    component.tipoOperacao = 'SELL';
    expect(component.ehProvento()).toBeFalse();

    component.tipoOperacao = 'BONIFICACAO';
    expect(component.ehProvento()).toBeFalse();

    component.tipoOperacao = 'DIVIDENDO';
    expect(component.ehProvento()).toBeTrue();

    component.tipoOperacao = 'JCP';
    expect(component.ehProvento()).toBeTrue();

    component.tipoOperacao = 'RENDIMENTO';
    expect(component.ehProvento()).toBeTrue();

    component.tipoOperacao = 'RESTITUICAO_CAPITAL';
    expect(component.ehProvento()).toBeTrue();
  });
});
