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

  it('editarLote deve chamar store.abrirModal com modo EDITAR_LOTE e o lote correspondente', () => {
    spyOn(store, 'abrirModal');

    component.editarLote(101);

    expect(store.abrirModal).toHaveBeenCalledWith('EDITAR_LOTE', jasmine.objectContaining({
      transacao_id: 101,
      quantidade_original: '25.35',
    }));
  });

  it('iniciarExclusaoLote, cancelarExclusaoLote e confirmarExclusaoLote devem gerenciar confirmacao inline e chamar store.excluirLote', async () => {
    spyOn(store, 'excluirLote').and.returnValue(Promise.resolve({} as any));

    expect(component.excluindoLoteId()).toBeNull();

    // 1. Inicia
    component.iniciarExclusaoLote(101);
    expect(component.excluindoLoteId()).toBe(101);

    // 2. Cancela
    component.cancelarExclusaoLote();
    expect(component.excluindoLoteId()).toBeNull();

    // 3. Inicia novamente e confirma
    component.iniciarExclusaoLote(101);
    await component.confirmarExclusaoLote(101);

    expect(store.excluirLote).toHaveBeenCalledWith(101);
    expect(component.excluindoLoteId()).toBeNull();
  });

  describe('Carteira Completa no componente PosicaoPeps', () => {
    const fakePosicaoCDI: PosicaoRendaFixa = {
      ativo: {
        id: 2,
        ticker: 'CDB-PAGBANK-120',
        nome: 'CDB PagBank 120% CDI',
        tipo: 'RendaFixa' as any,
        detalhes_rf: {
          ativo_id: 2,
          produto: 'CDB' as const,
          indexador: 'CDI' as const,
          emissor: 'PagBank',
          percentual_indexador: 120,
          data_vencimento: '2027-06-30',
          isento_ir: false,
          cobra_custodia_b3: false,
        },
      },
      lotes: [
        {
          transacao_id: 201,
          data_compra: '2026-02-10',
          taxa_contratada: '120',
          preco_unitario: '1000',
          quantidade_original: '10',
          quantidade_aberta: '10',
          custo_aberto_brl: '10000',
          custo_conhecido: true,
        },
      ],
      fluxos_recebidos: [],
      quantidade_total: '10',
      custo_total_brl: '10000',
      pendencias: [],
    };

    beforeEach(() => {
      store.ativos.set([fakePosicaoComPendencia.ativo, fakePosicaoCDI.ativo]);
      store.todasPosicoes.set([fakePosicaoComPendencia, fakePosicaoCDI]);
      store.ativoId.set(0);
      fixture.detectChanges();
    });

    it('em Carteira Completa deve exibir cabeçalho com coluna Título / Ativo', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const ths = Array.from(compiled.querySelectorAll('.data-table th')).map(th => th.textContent?.trim());
      expect(ths).toContain('Título / Ativo');
    });

    it('em Carteira Completa deve exibir badges de Título e Indexador nas linhas da tabela', () => {
      const compiled = fixture.nativeElement as HTMLElement;
      const badges = compiled.querySelectorAll('.badge-indexer');
      expect(badges.length).toBeGreaterThan(0);
      const tickers = Array.from(compiled.querySelectorAll('.ativo-cell strong')).map(t => t.textContent?.trim());
      expect(tickers).toContain('TD-RENDA+-2065');
      expect(tickers).toContain('CDB-PAGBANK-120');
    });

    it('em Carteira Completa allocationMode permite alternar para "titulo"', () => {
      expect(component.allocationMode()).toBe('indexador');
      component.setAllocationMode('titulo');
      expect(component.allocationMode()).toBe('titulo');
    });

    it('editarLote em Carteira Completa localiza o lote em todasPosicoes e abre modal', () => {
      spyOn(store, 'abrirModal');
      component.editarLote(201);
      expect(store.abrirModal).toHaveBeenCalledWith('EDITAR_LOTE', jasmine.objectContaining({
        transacao_id: 201,
        quantidade_original: '10',
      }));
    });

    it('exibe badge ISENTO para lote de ativo isento de IR sem contagem regressiva', () => {
      const fakePosIsenta: PosicaoRendaFixa = {
        ativo: {
          id: 3,
          ticker: 'LCI-DAYCOVAL-93',
          nome: 'LCI Daycoval 93% CDI',
          tipo: 'RendaFixa' as any,
          detalhes_rf: {
            ativo_id: 3,
            produto: 'LCI' as const,
            indexador: 'CDI' as const,
            emissor: 'Banco Daycoval',
            percentual_indexador: 93,
            isento_ir: true,
            cobra_custodia_b3: false,
          },
        },
        lotes: [
          {
            transacao_id: 301,
            data_compra: '2026-03-01',
            taxa_contratada: '93',
            preco_unitario: '1000',
            quantidade_original: '5',
            quantidade_aberta: '5',
            custo_aberto_brl: '5000',
            custo_conhecido: true,
          },
        ],
        fluxos_recebidos: [],
        quantidade_total: '5',
        custo_total_brl: '5000',
        pendencias: [],
      };
      store.todasPosicoes.set([fakePosIsenta]);
      store.ativoId.set(0);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const isentoBadges = compiled.querySelectorAll('.badge-success');
      const isentoText = Array.from(isentoBadges).map(b => b.textContent?.trim());
      expect(isentoText).toContain('ISENTO');
    });

    it('exibe mensagem informativa de tabela vazia quando não há lotes', () => {
      store.todasPosicoes.set([]);
      store.posicao.set(null);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const emptyMsg = compiled.querySelector('.empty-table-msg');
      expect(emptyMsg).toBeTruthy();
      expect(emptyMsg?.textContent).toContain('Nenhum lote cadastrado');
    });
  });
});

