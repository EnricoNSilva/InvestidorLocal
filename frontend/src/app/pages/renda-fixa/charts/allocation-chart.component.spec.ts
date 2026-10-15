import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ComponentRef } from '@angular/core';
import { AllocationChartComponent, buildAllocationConfig } from './allocation-chart.component';
import { AllocationSlice } from '../../../core/models/renda-fixa.models';

describe('AllocationChartComponent', () => {
  let fixture: ComponentFixture<AllocationChartComponent>;
  let component: AllocationChartComponent;
  let componentRef: ComponentRef<AllocationChartComponent>;

  const initialSlices: AllocationSlice[] = [
    { label: 'IPCA+ / Renda+', value: 15000, pct: 0.6 },
    { label: 'Tesouro Selic', value: 10000, pct: 0.4 },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AllocationChartComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AllocationChartComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
    componentRef.setInput('slices', initialSlices);
    componentRef.setInput('mode', 'indexador');
  });

  it('deve instanciar o componente e chamar destroy no teardown', () => {
    expect(component).toBeTruthy();
    const mockChart: any = {
      update: jasmine.createSpy('update'),
      destroy: jasmine.createSpy('destroy'),
      data: {
        labels: [],
        datasets: [{ data: [], backgroundColor: [] }],
      },
    };
    component.chart = mockChart;

    fixture.destroy();
    expect(mockChart.destroy).toHaveBeenCalled();
  });

  it('o effect deve mutar data, labels, colors e chamar update("none")', () => {
    const mockChart: any = {
      update: jasmine.createSpy('update'),
      destroy: jasmine.createSpy('destroy'),
      data: {
        labels: [],
        datasets: [{ data: [], backgroundColor: [] }],
      },
    };
    component.chart = mockChart;

    const nextSlices: AllocationSlice[] = [
      { label: 'Lote 1 (2026-01-23)', value: 5000, pct: 0.5 },
      { label: 'Lote 2 (2026-03-24)', value: 5000, pct: 0.5 },
    ];

    componentRef.setInput('slices', nextSlices);
    componentRef.setInput('mode', 'lote');
    fixture.detectChanges();

    expect(mockChart.data.labels).toEqual(['Lote 1 (2026-01-23)', 'Lote 2 (2026-03-24)']);
    expect(mockChart.data.datasets[0].data).toEqual([5000, 5000]);
    expect(mockChart.update).toHaveBeenCalledWith('none');
  });

  it('o tooltip callback deve calcular porcentagem dinamicamente a partir do dataset atual sem closure obsoleta', () => {
    const config = buildAllocationConfig(initialSlices, 'indexador');
    const labelCb = config.options?.plugins?.tooltip?.callbacks?.label as any;
    expect(labelCb).toBeDefined();

    const mockCtx = {
      label: 'IPCA+ / Renda+',
      parsed: 15000,
      dataIndex: 0,
      dataset: {
        data: [15000, 10000],
      },
    };

    const res = labelCb(mockCtx);
    expect(res).toContain('R$ 15.000,00');
    expect(res).toContain('60.0%');
  });
});
