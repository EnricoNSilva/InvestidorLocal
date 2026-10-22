import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { CarteiraConcentrationChartComponent } from './carteira-concentration-chart.component';
import { ChartPesoAtivosData } from '../../../core/models/investimento.models';

describe('CarteiraConcentrationChartComponent', () => {
  let fixture: ComponentFixture<CarteiraConcentrationChartComponent>;
  let component: CarteiraConcentrationChartComponent;
  let componentRef: ComponentRef<CarteiraConcentrationChartComponent>;

  const initialData: ChartPesoAtivosData = {
    labels: ['PETR4', 'MXRF11'],
    data: [3500, 525],
    percentual: [86.96, 13.04],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CarteiraConcentrationChartComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(CarteiraConcentrationChartComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('data', initialData);
    fixture.detectChanges();
  });

  it('deve instanciar o componente e exibir dados', () => {
    expect(component).toBeTruthy();
    expect(component.semDados()).toBeFalse();
  });

  it('deve marcar semDados como true quando não houver percentuais positivos', () => {
    componentRef.setInput('data', { labels: [], data: [], percentual: [] });
    fixture.detectChanges();
    expect(component.semDados()).toBeTrue();
  });
});
