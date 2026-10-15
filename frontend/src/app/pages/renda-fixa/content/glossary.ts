/**
 * Glossário Explicativo de Termos e Métricas Financeiras
 * Textos educativos para apoiar os balões explicativos (?) de IHC.
 */

export const GLOSSARY: Record<string, string> = {
  // Posição Atual
  totalInvestido:
    'Soma do dinheiro efetivamente desembolsado em todas as suas compras (custo histórico de aquisição).',
  saldoBruto:
    'Valor de mercado total dos seus títulos hoje antes de qualquer imposto ou taxa: Quantidade × PU de Resgate.',
  puResgate:
    'Preço Unitário pago hoje pelo Tesouro Nacional para recomprar 1 título na venda antecipada.',
  taxaMediaCompra:
    'Taxa média ponderada contratada em todos os seus aportes realizados no título: Σ(Taxa × Quantidade) ÷ Quantidade Total. Serve como régua comparativa: se a taxa atual de mercado estiver menor que sua taxa média, seus títulos estão valorizados pela marcação a mercado.',
  saldoLiqApp:
    'Valor exibido no Extrato Oficial do app do Tesouro Direto. Deduz o IR regressivo sobre o lucro, sem abater a custódia da B3.',
  saldoLiqReal:
    'Valor líquido final creditado na sua conta no resgate hoje (saldo final na corretora). Cálculo geral: Saldo Bruto − Imposto de Renda Regressivo (retido na fonte sobre o ganho de capital de cada lote) − Taxa de Custódia B3 (pro rata die). Reflete centavo por centavo o valor efetivo de liquidação.',
  rentabilidadeLiq:
    'Percentual de valorização líquida sobre o capital investido: (Saldo Líquido ÷ Total Investido) − 1.',
  tir:
    'Taxa Interna de Retorno anualizada equivalente (XIRR). Considera os dias exatos de cada aporte e mede o rendimento efetivo ao ano.',
  retornoReal:
    'Rentabilidade real líquida que superou a inflação oficial (IPCA), calculada pela equação de Fisher.',
  irRetido:
    'Imposto de Renda retido na fonte pela Tabela Regressiva da Renda Fixa (22,5% até 180 dias; 20% até 360 dias; 17,5% até 720 dias; 15% acima de 720 dias), apurado lote a lote.',
  custodiaB3:
    'Taxa de custódia cobrada pela B3 na venda antecipada (0,50% até 10 anos; 0,20% entre 10 e 20 anos; 0,10% acima de 20 anos pro rata die). No resgate no vencimento até 6 salários mínimos, é isenta.',
  taxaHoje:
    'Taxa real anual negociada a mercado pelo Tesouro Direto para o título hoje.',

  // Simulador
  prazoResgate: 'Tempo decorrido entre hoje e a data simulada da venda antecipada.',
  taxaVenda:
    'Taxa de juros real anual do título vigente no mercado no momento do resgate futuro.',
  convergencia:
    'Prazo em meses durante o qual a taxa de juros do mercado se desloca gradualmente da taxa atual até a taxa projetada.',
  ipcaProjetado:
    'Estimativa de inflação anual futura (IPCA) usada para corrigir o VNA e o valor nominal das parcelas.',
  puProjetado:
    'Preço Unitário projetado para 1 título na data da venda, considerando a inflação acumulada e a taxa de mercado.',
  saldoLiqProjetado:
    'Valor total líquido que você receberá na data da venda simulada (descontados IR e custódia B3).',
  ganhoLiqTotal:
    'Lucro líquido financeiro total na data da venda sobre o capital originalmente investido.',
  rentabilidadeSim:
    'Rentabilidade percentual líquida total acumulada desde as compras até a data da venda projetada.',
  tirSim:
    'Rentabilidade anualizada equivalente (ao ano) entre a data de cada compra e a data da venda projetada.',
  comparadoHoje:
    'Diferença financeira líquida entre vender na data projetada e vender hoje.',
  carregoPuro:
    'Ganho acumulado apenas pela passagem do tempo, rendendo os juros contratados em cada compra somados à inflação (IPCA).',
  marcacaoMercado:
    'Ganho ou perda decorrente da oscilação da taxa de mercado em relação à taxa contratada na compra (marcação a mercado).',
  peps:
    'Primeiro que Entra, Primeiro que Sai (FIFO): regra oficial do Tesouro onde os lotes mais antigos são vendidos primeiro, pagando menos IR.',

  // Análise de Risco & Matriz
  duration:
    'Duration Modificada (sensibilidade): mede quanto o preço do título oscila percentualmente para cada 1 p.p. de variação na taxa de juros.',
  taxaEmpate:
    'Taxa de mercado na venda em que o investidor empata financeiramente (lucro zero após impostos). Taxas abaixo geram lucro.',
  choqueTaxa:
    'Variação instantânea em pontos percentuais (p.p.) na taxa de juros negociada a mercado hoje.',
};
