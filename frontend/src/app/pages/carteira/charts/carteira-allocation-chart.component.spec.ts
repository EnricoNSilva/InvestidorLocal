import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { CarteiraAllocationChartComponent } from './carteira-allocation-chart.component';
import { ChartAlocacaoData } from '../../../core/models/investimento.models';

describe('CarteiraAllocationChartComponent', () => {
  let fixture: ComponentFixture<CarteiraAllocationChartComponent>;
  let component: CarteiraAllocationChartComponent;
  let componentRef: ComponentRef<CarteiraAllocationChartComponent>;

  const initialData: ChartAlocacaoData = {
    porAtivo: {
      labels: ['PETR4', 'KNRI11'],
      data: [3500, 525],
      percentual: [86.96, 13.04],
    },
    porClasse: {
      labels: ['Acao', 'FII'],
      data: [3500, 525],
      percentual: [86.96, 13.04],
    },
    porSetor: {
      labels: ['Petróleo e Combustíveis', 'Imobiliário (Híbrido)'],
      data: [3500, 525],
      percentual: [86.96, 13.04],
    },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CarteiraAllocationChartComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(CarteiraAllocationChartComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('data', initialData);
    componentRef.setInput('filtroClasse', 'PATRIMONIO');
    fixture.detectChanges();
  });

  it('deve instanciar o componente com modo ativo por padrão', () => {
    expect(component).toBeTruthy();
    expect(component.modo()).toBe('ativo');
    expect(component.semDados()).toBeFalse();
    expect(component.titulo()).toBe('Posições da Carteira');
  });

  it('deve alternar entre visão de Ativo, Setor e Classe', () => {
    component.setModo('setor');
    expect(component.modo()).toBe('setor');

    component.setModo('classe');
    expect(component.modo()).toBe('classe');

    component.setModo('ativo');
    expect(component.modo()).toBe('ativo');
  });

  it('deve adaptar título e rótulos contextualmente quando o filtro for ACAO', () => {
    componentRef.setInput('filtroClasse', 'ACAO');
    fixture.detectChanges();

    expect(component.titulo()).toBe('Posições em Ações');
    expect(component.labelBotaoAtivo()).toBe('Por Ação');
    expect(component.labelBotaoSetor()).toBe('Por Setor');
    expect(component.exibeBotaoClasse()).toBeFalse();
  });

  it('deve exibir overlay de sem dados quando valores forem zerados', () => {
    const emptyData: ChartAlocacaoData = {
      porAtivo: { labels: [], data: [], percentual: [] },
      porClasse: { labels: [], data: [], percentual: [] },
      porSetor: { labels: [], data: [], percentual: [] },
    };
    componentRef.setInput('data', emptyData);
    fixture.detectChanges();

    expect(component.semDados()).toBeTrue();
  });
});
