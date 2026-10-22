import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { HistoricoAtivoModalComponent } from './historico-ativo-modal.component';
import { CarteiraStore } from '../state/carteira.store';
import { CarteiraService } from '../../../core/services/carteira.service';
import { PosicaoEnriquecida, Transacao } from '../../../core/models/investimento.models';

describe('HistoricoAtivoModalComponent', () => {
  let fixture: ComponentFixture<HistoricoAtivoModalComponent>;
  let component: HistoricoAtivoModalComponent;
  let componentRef: ComponentRef<HistoricoAtivoModalComponent>;
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
      ticker: 'PETR4',
      nome: 'Petrobras PN',
      tipo: 'Acao',
      setor: 'Petróleo',
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
    cotacaoAtual: 35,
    fonteCotacao: 'YAHOO',
    variacaoDiariaPct: 1,
    valorMercado: 3500,
    lucroNaoRealizadoBrl: 500,
    rentabCotaPct: 16.67,
    retornoTotalBrl: 700,
    rentabTotalComDivPct: 23.33,
    yocPct: 6.67,
    lucroRealizadoBrl: 0,
    pesoCarteiraPct: 100,
  };

  const fakeTransacoes: Transacao[] = [
    {
      id: 1,
      ativo_id: 5,
      carteira_id: 1,
      tipo_operacao: 'BUY',
      data_hora: '2026-01-10T10:00:00Z',
      quantidade: 100,
      preco_unitario: 30,
      taxas: 5,
      moeda: 'BRL',
    },
    {
      id: 2,
      ativo_id: 5,
      carteira_id: 1,
      tipo_operacao: 'DIVIDENDO',
      data_hora: '2026-03-15T10:00:00Z',
      quantidade: 100,
      preco_unitario: 2,
      taxas: 0,
      moeda: 'BRL',
    },
  ];

  beforeEach(async () => {
    const spyService = jasmine.createSpyObj('CarteiraService', [
      'listarTransacoes',
      'criarTransacao',
      'atualizarTransacao',
      'excluirTransacao',
      'getPosicoes',
      'obterCotacoes',
    ]);
    spyService.carteiraAtivaId = jasmine.createSpy('carteiraAtivaId').and.returnValue(1);
    spyService.listarTransacoes.and.returnValue(of(fakeTransacoes));
    spyService.criarTransacao.and.returnValue(of(fakeTransacoes[0]));
    spyService.atualizarTransacao.and.returnValue(of(fakeTransacoes[0]));
    spyService.excluirTransacao.and.returnValue(of(undefined));
    spyService.getPosicoes.and.returnValue(of([fakePosicao.posicao]));
    spyService.obterCotacoes.and.returnValue(
      of({ carteira_id: 1, atualizado_em: '', stale: false, cotacoes: {} }),
    );

    await TestBed.configureTestingModule({
      imports: [HistoricoAtivoModalComponent],
      providers: [
        CarteiraStore,
        { provide: CarteiraService, useValue: spyService },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    store = TestBed.inject(CarteiraStore);
    carteiraService = TestBed.inject(CarteiraService) as jasmine.SpyObj<CarteiraService>;
    store.transacoesAtivoModal.set(fakeTransacoes);

    fixture = TestBed.createComponent(HistoricoAtivoModalComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;

    componentRef.setInput('isOpen', true);
    componentRef.setInput('posicao', fakePosicao);
    fixture.detectChanges();
  });

  it('deve listar as transações do ativo', () => {
    expect(component.transacoes().length).toBe(2);
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
  });

  it('deve chamar criarTransacao do store ao adicionar novo provento', async () => {
    spyOn(store, 'criarTransacao').and.returnValue(Promise.resolve());
    spyOn(component.atualizado, 'emit');

    component.novoTipo = 'DIVIDENDO';
    component.novaQtd = 100;
    component.novoPreco = 1.5;
    component.novasTaxas = 0;

    await component.adicionarTransacao();

    expect(store.criarTransacao).toHaveBeenCalledWith(
      jasmine.objectContaining({
        ativo_id: 5,
        tipo_operacao: 'DIVIDENDO',
        quantidade: 100,
        preco_unitario: 1.5,
      }),
    );
    expect(component.atualizado.emit).toHaveBeenCalled();
  });

  it('deve permitir iniciar e cancelar edição inline', () => {
    component.iniciarEdicao(fakeTransacoes[0]);
    expect(component.editandoId()).toBe(1);
    expect(component.editPreco).toBe(30);

    component.cancelarEdicao();
    expect(component.editandoId()).toBeNull();
  });

  it('deve chamar atualizarTransacao do store ao salvar edição válida', async () => {
    spyOn(store, 'atualizarTransacao').and.returnValue(Promise.resolve());
    spyOn(component.atualizado, 'emit');

    component.iniciarEdicao(fakeTransacoes[0]);
    component.editData = '2026-01-11';
    component.editQtd = 120;
    component.editPreco = 31;
    component.editTaxas = 6;

    await component.salvarEdicao(1);

    expect(store.atualizarTransacao).toHaveBeenCalledWith(
      1,
      jasmine.objectContaining({
        quantidade: 120,
        preco_unitario: 31,
        taxas: 6,
      }),
    );
    expect(component.editandoId()).toBeNull();
    expect(component.atualizado.emit).toHaveBeenCalled();
  });

  it('não deve salvar edição se a data for inválida ou quantidade <= 0', async () => {
    spyOn(store, 'atualizarTransacao');

    component.iniciarEdicao(fakeTransacoes[0]);
    component.editData = '';
    await component.salvarEdicao(1);

    expect(store.atualizarTransacao).not.toHaveBeenCalled();
    expect(component.erro()).toBe('Data da operação inválida.');

    component.editData = '2026-01-10';
    component.editQtd = 0;
    await component.salvarEdicao(1);

    expect(store.atualizarTransacao).not.toHaveBeenCalled();
    expect(component.erro()).toBe('A quantidade deve ser maior que zero.');
  });

  it('deve excluir transação com confirmação e chamar store.excluirTransacao', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    spyOn(store, 'excluirTransacao').and.returnValue(Promise.resolve());
    spyOn(component.atualizado, 'emit');

    await component.excluirTransacao(fakeTransacoes[0]);

    expect(window.confirm).toHaveBeenCalled();
    expect(store.excluirTransacao).toHaveBeenCalledWith(1);
    expect(component.atualizado.emit).toHaveBeenCalled();
  });

  it('não deve excluir transação se o usuário cancelar a confirmação', async () => {
    spyOn(window, 'confirm').and.returnValue(false);
    spyOn(store, 'excluirTransacao');

    await component.excluirTransacao(fakeTransacoes[0]);

    expect(window.confirm).toHaveBeenCalled();
    expect(store.excluirTransacao).not.toHaveBeenCalled();
  });
});
