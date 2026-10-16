import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NovoTituloRfModalComponent } from './novo-titulo-modal.component';
import { RendaFixaStore } from '../state/renda-fixa.store';
import { RendaFixaApiService } from '../../../core/services/renda-fixa-api.service';
import { AtivoRendaFixa, PosicaoRendaFixa } from '../../../core/models/renda-fixa.models';

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
  });
});
