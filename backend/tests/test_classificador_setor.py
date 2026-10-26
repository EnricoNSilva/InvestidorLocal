from app.services.classificador_setor import obter_setor_padrao, MAPA_SETORES_B3
from app.models.enums import TipoAtivo


def test_obter_setor_padrao_acoes_principais():
    assert obter_setor_padrao("BBAS3") == "Bancos"
    assert obter_setor_padrao("ITSA4") == "Bancos"
    assert obter_setor_padrao("BBSE3") == "Seguradoras"
    assert obter_setor_padrao("IRBR3") == "Seguradoras"
    assert obter_setor_padrao("SAPR4") == "Saneamento"
    assert obter_setor_padrao("KLBN4") == "Papel e Celulose"
    assert obter_setor_padrao("CMIG4") == "Energia Elétrica"
    assert obter_setor_padrao("VALE3") == "Mineração e Siderurgia"
    assert obter_setor_padrao("PETR4") == "Petróleo e Combustíveis"
    assert obter_setor_padrao("LEVE3") == "Automóveis e Peças"
    assert obter_setor_padrao("ALOS3") == "Imobiliário e Shoppings"
    assert obter_setor_padrao("TIMS3") == "Telecomunicações"
    assert obter_setor_padrao("MGLU3") == "Comércio e Varejo"


def test_obter_setor_padrao_fiis_e_cripto():
    assert obter_setor_padrao("HGLG11") == "Imobiliário (Logística)"
    assert obter_setor_padrao("HGBS11") == "Imobiliário (Shoppings)"
    assert obter_setor_padrao("XPCI11") == "Imobiliário (Papel / Recebíveis)"
    assert obter_setor_padrao("FII_NOVO11", tipo=TipoAtivo.FII) == "Imobiliário"

    assert obter_setor_padrao("BTC") == "Criptomoedas"
    assert obter_setor_padrao("SOL") == "Smart Contracts"
    assert obter_setor_padrao("CRIPTO_NOVA", tipo=TipoAtivo.Cripto) == "Criptomoedas"


def test_obter_setor_padrao_renda_fixa():
    assert obter_setor_padrao("TD-RENDA+-2065") == "Tesouro Direto"
    assert obter_setor_padrao("CDB-BANCO-2026") == "Títulos Bancários (CDB)"
    assert obter_setor_padrao("LCI-DI-2025") == "Crédito Imobiliário / Agro"
