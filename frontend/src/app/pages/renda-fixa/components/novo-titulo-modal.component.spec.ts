import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NovoTituloRfModalComponent, DRAFT_STORAGE_KEY } from './novo-titulo-modal.component';
import { RendaFixaStore } from '../state/renda-fixa.store';
import { RendaFixaApiService } from '../../../core/services/renda-fixa-api.service';
import {
  AtivoRendaFixa,
  LoteAbertoDto,
  PosicaoRendaFixa,
} from '../../../core/models/renda-fixa.models';

describe('NovoTituloRfModalComponent', () => {
  let component: NovoTituloRfModalComponent;
  let fixture: ComponentFixture<NovoTituloRfModalComponent>;
  let store: RendaFixaStore;

  const fakeAtivo: AtivoRendaFixa = {
    id: 1,
    ticker: 'CDB-TESTE',
    nome: 'CDB Teste',
    tipo: 'RendaFixa',
    setor: 'Renda Fixa',
    detalhes_rf: {
      ativo_id: 1,
      produto: 'CDB',
      indexador: 'CDI',
      emissor: 'Banco Teste',
      percentual_indexador: 110,
      data_vencimento: '2028-01-15',
      isento_ir: false,
      cobra_custodia_b3: false,
    },
  };

  const fakeLote: LoteAbertoDto = {
    transacao_id: 101,
    data_compra: '2025-05-10',
    taxa_contratada: '115.0',
    preco_unitario: '1050.00',
    quantidade_original: '10',
    quantidade_aberta: '10',
    custo_aberto_brl: '10500.00',
    custo_conhecido: true,
  };

  const fakePos: PosicaoRendaFixa = {
    ativo: fakeAtivo,
    lotes: [],
    fluxos_recebidos: [],
    quantidade_total: '0',
    custo_total_brl: '0',
    pendencias: [],
  };

  beforeEach(async () => {
    localStorage.removeItem(DRAFT_STORAGE_KEY);

    await TestBed.configureTestingModule({
      imports: [NovoTituloRfModalComponent],
      providers: [
        RendaFixaStore,
        RendaFixaApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    store = TestBed.inject(RendaFixaStore);
    store.ativos.set([fakeAtivo]);
    store.ativoId.set(1);

    fixture = TestBed.createComponent(NovoTituloRfModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  });

  it('deve instanciar o componente com valores padrão', () => {
    expect(component).toBeTruthy();
    expect(component.mode()).toBe('NOVO_TITULO');
    expect(component.produto).toBe('CDB');
    expect(component.indexador).toBe('CDI');
    expect(component.isentoIr).toBeFalse();
    expect(component.cobraCustodiaB3).toBeFalse();
  });

  it('deve alternar entre modos NOVO_TITULO e NOVO_APORTE', () => {
    component.setMode('NOVO_APORTE');
    expect(component.mode()).toBe('NOVO_APORTE');
    expect(component.selectedAtivoId).toBe(1);

    component.setMode('NOVO_TITULO');
    expect(component.mode()).toBe('NOVO_TITULO');
  });

  it('deve preencher campos corretamente com os presets', () => {
    // 1. Preset CDB CDI
    component.applyPreset('CDB_CDI');
    expect(component.produto).toBe('CDB');
    expect(component.indexador).toBe('CDI');
    expect(component.loteTaxa).toBe(110);
    expect(component.isentoIr).toBeFalse();
    expect(component.cobraCustodiaB3).toBeFalse();

    // 2. Preset LCI CDI
    component.applyPreset('LCI_CDI');
    expect(component.produto).toBe('LCI');
    expect(component.indexador).toBe('CDI');
    expect(component.loteTaxa).toBe(93);
    expect(component.isentoIr).toBeTrue();
    expect(component.cobraCustodiaB3).toBeFalse();

    // 3. Preset CDB Pré
    component.applyPreset('CDB_PRE');
    expect(component.produto).toBe('CDB');
    expect(component.indexador).toBe('PREFIXADO');
    expect(component.loteTaxa).toBe(12.5);

    // 4. Preset Tesouro Selic
    component.applyPreset('TESOURO_SELIC');
    expect(component.produto).toBe('TESOURO_SELIC');
    expect(component.indexador).toBe('SELIC');
    expect(component.cobraCustodiaB3).toBeTrue();
    expect(component.loteTaxa).toBe(0.05);
  });

  it('deve validar o formulário antes de permitir salvar', () => {
    component.nome = '';
    expect(component.isFormValid()).toBeFalse();

    component.nome = 'CDB Inter 110%';
    component.loteQtd = 0;
    expect(component.isFormValid()).toBeFalse();

    component.loteQtd = 10;
    component.lotePreco = 1000;
    expect(component.isFormValid()).toBeTrue();
  });

  it('deve chamar store.criarTituloManual e emitir close ao submeter novo título válido', async () => {
    spyOn(store, 'criarTituloManual').and.returnValue(Promise.resolve(fakePos));
    let closed = false;
    component.close.subscribe(() => (closed = true));

    component.applyPreset('LCI_CDI');
    await component.salvar();

    expect(store.criarTituloManual).toHaveBeenCalled();
    expect(closed).toBeTrue();
    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('deve chamar store.adicionarLote e emitir close ao submeter aporte em ativo existente', async () => {
    spyOn(store, 'adicionarLote').and.returnValue(Promise.resolve(fakePos));
    let closed = false;
    component.close.subscribe(() => (closed = true));

    component.setMode('NOVO_APORTE');
    component.selectedAtivoId = 1;
    component.loteQtd = 5;
    component.lotePreco = 1000;
    component.loteTaxa = 110;
    await component.salvar();

    expect(store.adicionarLote).toHaveBeenCalledWith(1, jasmine.objectContaining({
      quantidade: 5,
      preco_unitario: 1000,
      taxa_contratada: 110,
    }));
    expect(closed).toBeTrue();
    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('não deve emitir close ao clicar no backdrop (onBackdropClick)', () => {
    let closed = false;
    component.close.subscribe(() => (closed = true));

    const fakeEvent = {
      target: { classList: { contains: () => true } },
    } as any;

    component.onBackdropClick(fakeEvent);
    expect(closed).toBeFalse();
  });

  it('deve persistir rascunho no localStorage e limpar ao clicar em Limpar Campos', () => {
    component.nome = 'Rascunho de Teste';
    component.emissor = 'Banco Rascunho';
    component.saveDraft();

    const saved = localStorage.getItem(DRAFT_STORAGE_KEY);
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved!).nome).toBe('Rascunho de Teste');

    component.limparCampos();
    expect(component.nome).toBe('');
    expect(localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(component.hasRestoredDraft()).toBeFalse();
  });

  it('deve restaurar rascunho válido do localStorage ao inicializar', () => {
    const draftData = {
      mode: 'NOVO_TITULO',
      nome: 'CDB Restaurado do Cache',
      emissor: 'Banco Restaurado',
      produto: 'CDB',
      indexador: 'CDI',
      lotePreco: 1200,
      loteQtd: 3,
      loteTaxa: 112,
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftData));

    const fix2 = TestBed.createComponent(NovoTituloRfModalComponent);
    const comp2 = fix2.componentInstance;
    fix2.detectChanges();

    expect(comp2.hasRestoredDraft()).toBeTrue();
    expect(comp2.nome).toBe('CDB Restaurado do Cache');
    expect(comp2.emissor).toBe('Banco Restaurado');
    expect(comp2.lotePreco).toBe(1200);
    expect(comp2.loteQtd).toBe(3);
    expect(comp2.loteTaxa).toBe(112);
  });

  it('deve suportar modo EDITAR_TITULO recebendo editingAtivo e chamando store.atualizarTitulo', async () => {
    spyOn(store, 'atualizarTitulo').and.returnValue(Promise.resolve(fakePos));
    let closed = false;

    const fixEdit = TestBed.createComponent(NovoTituloRfModalComponent);
    fixEdit.componentRef.setInput('initialMode', 'EDITAR_TITULO');
    fixEdit.componentRef.setInput('editingAtivo', fakeAtivo);
    const compEdit = fixEdit.componentInstance;
    compEdit.close.subscribe(() => (closed = true));
    fixEdit.detectChanges();

    expect(compEdit.mode()).toBe('EDITAR_TITULO');
    expect(compEdit.nome).toBe('CDB Teste');
    expect(compEdit.ticker).toBe('CDB-TESTE');
    expect(compEdit.emissor).toBe('Banco Teste');
    expect(compEdit.loteTaxa).toBe(110);

    compEdit.nome = 'CDB Teste Atualizado';
    await compEdit.salvar();

    expect(store.atualizarTitulo).toHaveBeenCalledWith(1, jasmine.objectContaining({
      nome: 'CDB Teste Atualizado',
      ticker: 'CDB-TESTE',
    }));
    expect(closed).toBeTrue();
  });

  it('deve suportar modo EDITAR_LOTE recebendo editingLote e chamando store.editarLote', async () => {
    spyOn(store, 'editarLote').and.returnValue(Promise.resolve(fakePos));
    let closed = false;

    const fixLote = TestBed.createComponent(NovoTituloRfModalComponent);
    fixLote.componentRef.setInput('initialMode', 'EDITAR_LOTE');
    fixLote.componentRef.setInput('editingLote', fakeLote);
    const compLote = fixLote.componentInstance;
    compLote.close.subscribe(() => (closed = true));
    fixLote.detectChanges();

    expect(compLote.mode()).toBe('EDITAR_LOTE');
    expect(compLote.loteData).toBe('2025-05-10');
    expect(compLote.lotePreco).toBe(1050);
    expect(compLote.loteQtd).toBe(10);
    expect(compLote.loteTaxa).toBe(115);

    compLote.loteQtd = 12;
    await compLote.salvar();

    expect(store.editarLote).toHaveBeenCalledWith(101, jasmine.objectContaining({
      quantidade: 12,
      preco_unitario: 1050,
      taxa_contratada: 115,
    }));
    expect(closed).toBeTrue();
  });

  it('EDITAR_TITULO deve preservar ano_conversao e num_parcelas em titulos de desacumulacao (RendA+)', async () => {
    spyOn(store, 'atualizarTitulo').and.returnValue(Promise.resolve(fakePos));
    let closed = false;

    const rendaMaisAtivo: AtivoRendaFixa = {
      id: 99,
      ticker: 'NTNB-2065',
      nome: 'Tesouro RendA+ 2065',
      tipo: 'RendaFixa',
      detalhes_rf: {
        ativo_id: 99,
        produto: 'TESOURO_RENDA_MAIS',
        indexador: 'IPCA',
        emissor: 'Tesouro Nacional',
        ano_conversao: 2065,
        num_parcelas: 240,
        dia_pagamento: 15,
        isento_ir: false,
        cobra_custodia_b3: true,
      },
    };

    const fixRendaMais = TestBed.createComponent(NovoTituloRfModalComponent);
    fixRendaMais.componentRef.setInput('initialMode', 'EDITAR_TITULO');
    fixRendaMais.componentRef.setInput('editingAtivo', rendaMaisAtivo);
    const compRendaMais = fixRendaMais.componentInstance;
    compRendaMais.close.subscribe(() => (closed = true));
    fixRendaMais.detectChanges();

    compRendaMais.nome = 'Tesouro RendA+ 2065 Aposentadoria';
    await compRendaMais.salvar();

    expect(store.atualizarTitulo).toHaveBeenCalledWith(99, jasmine.objectContaining({
      nome: 'Tesouro RendA+ 2065 Aposentadoria',
      detalhes: jasmine.objectContaining({
        produto: 'TESOURO_RENDA_MAIS',
        ano_conversao: 2065,
        num_parcelas: 240,
      }),
    }));
    expect(closed).toBeTrue();
  });

  it('EDITAR_LOTE com venda parcial deve pré-preencher com quantidade_original e preservar taxas', async () => {
    spyOn(store, 'editarLote').and.returnValue(Promise.resolve(fakePos));
    let closed = false;

    const loteComVendaParcial: LoteAbertoDto = {
      transacao_id: 202,
      data_compra: '2024-03-01',
      taxa_contratada: '120.0',
      preco_unitario: '1000.00',
      quantidade_original: '15.0',
      quantidade_aberta: '9.0', // 6 foram vendidos
      custo_aberto_brl: '9000.00',
      taxas: '30.0',
      custo_conhecido: true,
    };

    const fixLoteParcial = TestBed.createComponent(NovoTituloRfModalComponent);
    fixLoteParcial.componentRef.setInput('initialMode', 'EDITAR_LOTE');
    fixLoteParcial.componentRef.setInput('editingLote', loteComVendaParcial);
    const compLoteParcial = fixLoteParcial.componentInstance;
    compLoteParcial.close.subscribe(() => (closed = true));
    fixLoteParcial.detectChanges();

    // Deve carregar a quantidade_original (15), NÃO o saldo aberto (9), e carregar taxas (30)
    expect(compLoteParcial.loteQtd).toBe(15);
    expect(compLoteParcial.loteTaxas).toBe(30);

    // Salvar sem alterar quantidade para confirmar que taxas e quantidade_original são enviadas
    await compLoteParcial.salvar();

    expect(store.editarLote).toHaveBeenCalledWith(202, jasmine.objectContaining({
      quantidade: 15,
      taxas: 30,
    }));
    expect(closed).toBeTrue();
  });

  it('restoreDraft não deve ativar hasRestoredDraft quando o rascunho for vazio ou sem dados significativos', () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({}));

    const fixVazio = TestBed.createComponent(NovoTituloRfModalComponent);
    const compVazio = fixVazio.componentInstance;
    fixVazio.detectChanges();

    expect(compVazio.hasRestoredDraft()).toBeFalse();
  });
});
