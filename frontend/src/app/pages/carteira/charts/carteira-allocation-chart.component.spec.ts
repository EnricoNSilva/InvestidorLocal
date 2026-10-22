import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { CarteiraAllocationChartComponent } from './carteira-allocation-chart.component';
import { ChartAlocacaoData } from '../../../core/models/investimento.models';

describe('CarteiraAllocationChartComponent', () => {
  let fixture: ComponentFixture<CarteiraAllocationChartComponent>;
  let component: CarteiraAllocationChartComponent;
  let componentRef: ComponentRef<CarteiraAllocationChartComponent>;

  const initialData: ChartAlocacaoData = {
    porClasse: {
      labels: ['Acao', 'FII'],
      data: [3500, 525],
      percentual: [86.96, 13.04],
    },
    porSetor: {
      labels: ['Petróleo e Gás', 'Híbrido'],
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
    fixture.detectChanges();
  });

  it('deve instanciar o componente com modo classe por padrão', () => {
    expect(component).toBeTruthy();
    expect(component.modo()).toBe('classe');
    expect(component.semDados()).toBeFalse();
  });

  it('deve alternar entre visão de Classe e Setor', () => {
    component.setModo('setor');
    expect(component.modo()).toBe('setor');

    component.setModo('classe');
    expect(component.modo()).toBe('classe');
  });

  it('deve exibir overlay de sem dados quando valores forem zerados', () => {
    const emptyData: ChartAlocacaoData = {
      porClasse: { labels: [], data: [], percentual: [] },
      porSetor: { labels: [], data: [], percentual: [] },
    };
    componentRef.setInput('data', emptyData);
    fixture.detectChanges();

    expect(component.semDados()).toBeTrue();
  });
});
