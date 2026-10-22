import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { CarteiraProventosChartComponent } from './carteira-proventos-chart.component';
import { ChartRankingProventosData } from '../../../core/models/investimento.models';

describe('CarteiraProventosChartComponent', () => {
  let fixture: ComponentFixture<CarteiraProventosChartComponent>;
  let component: CarteiraProventosChartComponent;
  let componentRef: ComponentRef<CarteiraProventosChartComponent>;

  const initialData: ChartRankingProventosData = {
    labels: ['PETR4', 'MXRF11'],
    proventos: [250, 50],
    yoc: [8.33, 9.5],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CarteiraProventosChartComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(CarteiraProventosChartComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('data', initialData);
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
});
