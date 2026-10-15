import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { RateTrajectoryChartComponent } from './rate-trajectory-chart.component';
import { RatePoint } from '../../../core/financial-engine/types';

describe('RateTrajectoryChartComponent', () => {
  let fixture: ComponentFixture<RateTrajectoryChartComponent>;
  let component: RateTrajectoryChartComponent;
  let componentRef: ComponentRef<RateTrajectoryChartComponent>;

  const initialPoints: RatePoint[] = [
    { month: 0, label: 'Hoje', ratePct: 6.55 },
    { month: 12, label: '12m', ratePct: 6.55 },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RateTrajectoryChartComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RateTrajectoryChartComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('points', initialPoints);
  });

  it('deve instanciar o componente e chamar destroy no teardown', () => {
    expect(component).toBeTruthy();
    const mockChart: any = {
      update: jasmine.createSpy('update'),
      destroy: jasmine.createSpy('destroy'),
      data: {
        labels: [],
        datasets: [{ data: [] }],
      },
      options: {
        scales: {
          y: { min: 0, max: 10, ticks: { stepSize: 0.5 } },
        },
      },
    };
    component.chart = mockChart;

    fixture.destroy();
    expect(mockChart.destroy).toHaveBeenCalled();
  });

  it('o effect deve mutar labels, data e chamar update("none")', () => {
    const mockChart: any = {
      update: jasmine.createSpy('update'),
      destroy: jasmine.createSpy('destroy'),
      data: {
        labels: [],
        datasets: [{ data: [] }],
      },
      options: {
        scales: {
          y: { min: 0, max: 10, ticks: { stepSize: 0.5 } },
        },
      },
    };
    component.chart = mockChart;

    const nextPoints: RatePoint[] = [
      { month: 0, label: 'Hoje', ratePct: 6.55 },
      { month: 6, label: '6m', ratePct: 7.0 },
      { month: 12, label: '12m', ratePct: 7.5 },
    ];

    componentRef.setInput('points', nextPoints);
    fixture.detectChanges();

    expect(mockChart.data.labels).toEqual(['Hoje', '6m', '12m']);
    expect(mockChart.data.datasets[0].data).toEqual([6.55, 7.0, 7.5]);
    expect(mockChart.update).toHaveBeenCalledWith('none');
  });
});
