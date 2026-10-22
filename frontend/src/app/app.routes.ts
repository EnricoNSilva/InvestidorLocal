import { Routes } from '@angular/router';
import { ImportacaoComponent } from './pages/importacao/importacao.component';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/carteira/carteira.component').then((m) => m.CarteiraComponent),
    title: 'Carteira Consolidada - Meu Investidor Local',
  },
  { path: 'importacao', component: ImportacaoComponent, title: 'Importação de Planilhas - Meu Investidor Local' },
  {
    path: 'renda-fixa',
    loadChildren: () => import('./pages/renda-fixa/renda-fixa.routes'),
  },
  { path: '**', redirectTo: '' }
];
