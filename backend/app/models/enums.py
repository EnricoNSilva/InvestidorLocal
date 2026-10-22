import enum

class TipoAtivo(str, enum.Enum):
    Acao = "Acao"
    FII = "FII"
    Cripto = "Cripto"
    RendaFixa = "RendaFixa"

class TipoOperacao(str, enum.Enum):
    BUY = "BUY"
    SELL = "SELL"
    TRANSFERENCIA_ENTRADA = "TRANSFERENCIA_ENTRADA"
    BONIFICACAO = "BONIFICACAO"
    DIREITO_SUBSCRICAO = "DIREITO_SUBSCRICAO"
    DIREITO_SUBSCRICAO_EXPIRADO = "DIREITO_SUBSCRICAO_EXPIRADO"
    AMORTIZACAO = "AMORTIZACAO"          # NOVO: evento de caixa de RF (não altera quantidade)
    JUROS_CUPOM = "JUROS_CUPOM"          # NOVO: cupom semestral (Tesouro IPCA+ c/ juros, debêntures)
    DIVIDENDO = "DIVIDENDO"              # RV: dividendos isentos (Ações)
    JCP = "JCP"                          # RV: juros sobre capital próprio (líquido)
    RENDIMENTO = "RENDIMENTO"            # RV: rendimentos de FIIs / FIAGROs
    RESTITUICAO_CAPITAL = "RESTITUICAO_CAPITAL"  # RV: restituição/amortização de capital (reduz custo fiscal)
    DESDOBRO = "DESDOBRO"                # RV: desdobramento de ações (aumenta quantidade sem alterar custo total)
    GRUPAMENTO = "GRUPAMENTO"            # RV: grupamento de ações (altera quantidade sem alterar custo total)
    FRACAO_ATIVOS = "FRACAO_ATIVOS"      # RV: fração de ativos (reduz fração de saldo)
    LEILAO_FRACAO = "LEILAO_FRACAO"      # RV: leilão de fração (recebimento financeiro em dinheiro)

class Indexador(str, enum.Enum):          # NOVO
    IPCA = "IPCA"
    CDI = "CDI"
    SELIC = "SELIC"
    PREFIXADO = "PREFIXADO"

class ProdutoRendaFixa(str, enum.Enum):   # NOVO
    TESOURO_RENDA_MAIS = "TESOURO_RENDA_MAIS"
    TESOURO_EDUCA_MAIS = "TESOURO_EDUCA_MAIS"
    TESOURO_IPCA = "TESOURO_IPCA"
    TESOURO_IPCA_JUROS = "TESOURO_IPCA_JUROS"
    TESOURO_SELIC = "TESOURO_SELIC"
    TESOURO_PREFIXADO = "TESOURO_PREFIXADO"
    TESOURO_PREFIXADO_JUROS = "TESOURO_PREFIXADO_JUROS"
    CDB = "CDB"
    LCI = "LCI"
    LCA = "LCA"
    LC = "LC"
    OUTRO = "OUTRO"
