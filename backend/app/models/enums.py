import enum

class TipoAtivo(str, enum.Enum):
    Acao = "Acao"
    FII = "FII"
    Cripto = "Cripto"
    RendaFixa = "RendaFixa"

class TipoOperacao(str, enum.Enum):
    BUY = "BUY"
    SELL = "SELL"
