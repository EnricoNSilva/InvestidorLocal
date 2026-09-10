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
