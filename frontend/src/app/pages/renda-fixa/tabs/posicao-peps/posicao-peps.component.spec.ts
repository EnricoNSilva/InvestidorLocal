import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { PosicaoPepsComponent } from './posicao-peps.component';
import { RendaFixaStore } from '../../state/renda-fixa.store';
import { RendaFixaApiService } from '../../../../core/services/renda-fixa-api.service';
import { PosicaoRendaFixa } from '../../../../core/models/renda-fixa.models';

describe('PosicaoPepsComponent', () => {
  let fixture: ComponentFixture<PosicaoPepsComponent>;
  let component: PosicaoPepsComponent;
  let store: RendaFixaStore;

  const fakePosicaoComPendencia: PosicaoRendaFixa = {
    ativo: {
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
    },
    lotes: [
      {
        transacao_id: 101,
        data_compra: '2026-01-23',
        taxa_contratada: '6.99',
        preco_unitario: '185.02',
        quantidade_original: '25.35',
        quantidade_aberta: '25.35',
        custo_aberto_brl: '4690.26',
        custo_conhecido: true,
      },
      {
        transacao_id: 102,
        data_compra: '2026-03-24',
        taxa_contratada: null, // PENDÊNCIA: sem taxa contratada!
        preco_unitario: '177.03',
        quantidade_original: '50.00',
        quantidade_aberta: '50.00',
        custo_aberto_brl: '8851.50',
        custo_conhecido: true,
      },
    ],
    fluxos_recebidos: [],
    quantidade_total: '75.35',
    custo_total_brl: '13541.76',
    pendencias: ['Lote 102 sem taxa contratada'],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PosicaoPepsComponent],
      providers: [
        RendaFixaStore,
        RendaFixaApiService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    store = TestBed.inject(RendaFixaStore);
    store.posicao.set(fakePosicaoComPendencia);

    fixture = TestBed.createComponent(PosicaoPepsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('lote sem taxa contratada aparece como pendência e NÃO entra em lots() do motor', () => {
    // 1. O store deve filtrar o lote sem taxa de lots()
    expect(store.lots().length).toBe(1);
    expect(store.lots()[0].id).toBe(101);
    expect(store.pendencias().length).toBe(1);

    // 2. O template deve exibir o banner de alerta e a linha pendente para edição inline
    const compiled = fixture.nativeElement as HTMLElement;
    const banner = compiled.querySelector('.pending-banner');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('Lotes Pendentes de Taxa Contratada');

    const pendingRow = compiled.querySelector('.pending-row');
    expect(pendingRow).toBeTruthy();
    expect(pendingRow?.textContent).toContain('Taxa Pendente');
  });

  it('salvarTaxa deve chamar store.salvarTaxa com transacaoId e valor', async () => {
    spyOn(store, 'salvarTaxa').and.returnValue(Promise.resolve());
    const lotePendente = fakePosicaoComPendencia.lotes[1];

    component.taxaDrafts[lotePendente.transacao_id] = 7.14;
    await component.salvarTaxa(lotePendente);

    expect(store.salvarTaxa).toHaveBeenCalledWith(102, 7.14);
  });
});
