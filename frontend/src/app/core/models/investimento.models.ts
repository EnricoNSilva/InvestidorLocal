export type TipoAtivo = 'Acao' | 'FII' | 'Cripto' | 'RendaFixa';

export type TipoOperacao = 'BUY' | 'SELL' | 'TRANSFERENCIA_ENTRADA';

export interface Ativo {
  id: number;
  ticker: string;
  nome: string;
  tipo: TipoAtivo;
  setor?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PosicaoConsolidada {
  id: number;
  ativo_id: number;
  quantidade_saldo: string | number;
  custo_total_brl: string | number;
  preco_medio_brl: string | number;
  data_atualizacao: string;
  ativo?: Ativo | null;
}

export interface Transacao {
  id: number;
  ativo_id: number;
  data_hora: string;
  tipo_operacao: TipoOperacao;
  quantidade: string | number;
  preco_unitario: string | number;
  taxas: string | number;
  moeda: string;
  moeda_taxa?: string | null;
  ptax_utilizada?: string | number | null;
  created_at?: string;
}

export interface RetornoImportacao {
  status: string;
  origem: string;
  filename: string;
  transacoes_processadas?: number;
  transferencias_processadas?: number;
  mensagem: string;
  pendencias?: string[];
  avisos?: string[];
}
