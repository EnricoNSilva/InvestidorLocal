import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { ProjectionChartComponent } from './projection-chart.component';
import { ProjectionSeries } from '../../../core/models/renda-fixa.models';

describe('ProjectionChartComponent', () => {
  let fixture: ComponentFixture<ProjectionChartComponent>;
  let component: ProjectionChartComponent;
  let componentRef: ComponentRef<ProjectionChartComponent>;

  const initialData: ProjectionSeries = {
    labels: ['Hoje', '1a'],
    series: {
      alvo: [1000, 1100],
      carrego: [1000, 1080],
      cdi: [1000, 1090],
      queda5: [1000, 1200],
      alta8: [1000, 950],
    },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectionChartComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ProjectionChartComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('data', initialData);
  });

  it('deve instanciar o componente e chamar destroy no teardown', () => {
    expect(component).toBeTruthy();
    const mockChart: any = {
      update: jasmine.createSpy('update'),
      destroy: jasmine.createSpy('destroy'),
      data: {
        labels: [],
        datasets: [
          { data: [] },
          { data: [] },
          { data: [] },
          { data: [] },
          { data: [] },
        ],
      },
    };
    component.chart = mockChart;

    fixture.destroy();
    expect(mockChart.destroy).toHaveBeenCalled();
  });

  it('o effect deve mutar chart.data e chamar update("none")', () => {
    const mockChart: any = {
      update: jasmine.createSpy('update'),
      destroy: jasmine.createSpy('destroy'),
      data: {
        labels: [],
        datasets: [
          { data: [] },
          { data: [] },
          { data: [] },
          { data: [] },
          { data: [] },
        ],
      },
    };
    component.chart = mockChart;

    const nextData: ProjectionSeries = {
      labels: ['Hoje', '1a', '2a'],
      series: {
        alvo: [1000, 1100, 1200],
        carrego: [1000, 1080, 1160],
        cdi: [1000, 1090, 1180],
        queda5: [1000, 1200, 1400],
        alta8: [1000, 950, 900],
      },
    };

    componentRef.setInput('data', nextData);
    fixture.detectChanges();

    expect(mockChart.data.labels).toEqual(['Hoje', '1a', '2a']);
    expect(mockChart.data.datasets[0].data).toEqual([1000, 1100, 1200]);
    expect(mockChart.update).toHaveBeenCalledWith('none');
  });
});
