import { Routes } from '@angular/router';
import { CarteiraComponent } from './pages/carteira/carteira.component';
import { ImportacaoComponent } from './pages/importacao/importacao.component';

export const routes: Routes = [
  { path: '', component: CarteiraComponent, title: 'Carteira Consolidada - Meu Investidor Local' },
  { path: 'importacao', component: ImportacaoComponent, title: 'Importação de Planilhas - Meu Investidor Local' },
  { path: '**', redirectTo: '' }
];
