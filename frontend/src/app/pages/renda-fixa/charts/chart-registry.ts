import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  DoughnutController,
  ArcElement,
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';

let registered = false;

export function registerCharts(): void {
  if (registered) return;
  Chart.register(
    LineController,
    LineElement,
    PointElement,
    DoughnutController,
    ArcElement,
    BarController,
    BarElement,
    LinearScale,
    CategoryScale,
    Filler,
    Tooltip,
    Legend
  );
  registered = true;
}
