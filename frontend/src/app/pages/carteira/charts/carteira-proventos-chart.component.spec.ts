import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { CarteiraProventosChartComponent } from './carteira-proventos-chart.component';
import {
  ChartRankingProventosData,
  ProventosAtivoAnual,
} from '../../../core/models/investimento.models';

describe('CarteiraProventosChartComponent', () => {
  let fixture: ComponentFixture<CarteiraProventosChartComponent>;
  let component: CarteiraProventosChartComponent;
  let componentRef: ComponentRef<CarteiraProventosChartComponent>;

  const initialData: ChartRankingProventosData = {
    labels: ['PETR4', 'MXRF11'],
    proventos: [250, 50],
    yoc: [8.33, 9.5],
  };

  const mockProventosAnuais: ProventosAtivoAnual[] = [
    {
      ativo_id: 1,
      ticker: 'PETR4',
      nome: 'Petrobras PN',
      tipo_ativo: 'Acao',
      em_custodia: true,
      quantidade_saldo: 100,
      total_dividendos_brl: 600,
      total_jcp_brl: 400,
      total_rendimentos_brl: 0,
      total_div_jcp_brl: 1000,
      total_geral_brl: 1000,
      pct_dividendo_total: 60,
      pct_jcp_total: 40,
      anos: [
        {
          ano: 2023,
          dividendos_brl: 200,
          jcp_brl: 200,
          rendimentos_brl: 0,
          total_div_jcp_brl: 400,
          total_geral_brl: 400,
          pct_dividendo: 50,
          pct_jcp: 50,
          qtd_pagamentos_dividendo: 1,
          qtd_pagamentos_jcp: 1,
          qtd_pagamentos_rendimento: 0,
        },
        {
          ano: 2024,
          dividendos_brl: 400,
          jcp_brl: 200,
          rendimentos_brl: 0,
          total_div_jcp_brl: 600,
          total_geral_brl: 600,
          pct_dividendo: 66.67,
          pct_jcp: 33.33,
          qtd_pagamentos_dividendo: 2,
          qtd_pagamentos_jcp: 1,
          qtd_pagamentos_rendimento: 0,
        },
      ],
    },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CarteiraProventosChartComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(CarteiraProventosChartComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('data', initialData);
    componentRef.setInput('proventosAnuais', mockProventosAnuais);
    fixture.detectChanges();
  });

  it('deve instanciar o componente e exibir dados', () => {
    expect(component).toBeTruthy();
    expect(component.semDados()).toBeFalse();
  });

  it('deve marcar semDados como true quando proventos forem zerados', () => {
    componentRef.setInput('data', { labels: [], proventos: [], yoc: [] });
    fixture.detectChanges();
    expect(component.semDados()).toBeTrue();
  });

  it('deve aceitar titulo e subtitulo customizados via inputs', () => {
    componentRef.setInput('titulo', 'Top Geradores de Rendimentos (EARN)');
    componentRef.setInput('subtitulo', 'Rendimentos de Staking');
    fixture.detectChanges();
    expect(component.titulo()).toBe('Top Geradores de Rendimentos (EARN)');
    expect(component.subtitulo()).toBe('Rendimentos de Staking');
  });

  it('deve alternar para modoVisao ANUAL e calcular dados anuais corretamente', () => {
    component.setModoVisao('ANUAL');
    fixture.detectChanges();

    expect(component.modoVisao()).toBe('ANUAL');
    const anual = component.dadosAnuais();
    expect(anual.anosLabels).toEqual(['2023', '2024']);
    expect(anual.totalDivAcumulado).toBe(600);
    expect(anual.totalJcpAcumulado).toBe(400);
    expect(anual.totalDivJcpAcumulado).toBe(1000);
    expect(anual.pctDivAcumulado).toBe(60);
    expect(anual.pctJcpAcumulado).toBe(40);
    expect(anual.dividendosPct).toEqual([50, 66.67]);
    expect(anual.jcpPct).toEqual([50, 33.33]);
  });

  it('deve alternar unidadeAnual entre PCT e BRL', () => {
    expect(component.unidadeAnual()).toBe('PCT');
    component.setUnidadeAnual('BRL');
    expect(component.unidadeAnual()).toBe('BRL');
    component.setUnidadeAnual('PCT');
    expect(component.unidadeAnual()).toBe('PCT');
  });
});

