"""Serviço de classificação de setor para ativos do mercado financeiro brasileiro (B3), FIIs e Criptoativos."""
from typing import Optional, Any


# Mapeamento oficial e consolidado de tickers B3 -> Setores de atuação
MAPA_SETORES_B3: dict[str, str] = {
    # --- Bancos & Holdings Financeiras ---
    "BBAS3": "Bancos",
    "BBDC3": "Bancos",
    "BBDC4": "Bancos",
    "ITUB3": "Bancos",
    "ITUB4": "Bancos",
    "ITSA3": "Bancos",
    "ITSA4": "Bancos",
    "SANB3": "Bancos",
    "SANB4": "Bancos",
    "SANB11": "Bancos",
    "BEES3": "Bancos",
    "BEES4": "Bancos",
    "BPAC3": "Bancos",
    "BPAC5": "Bancos",
    "BPAC11": "Bancos",
    "BRSR3": "Bancos",
    "BRSR6": "Bancos",
    "BMIN4": "Bancos",
    "ABCB4": "Bancos",
    "MODL3": "Bancos",

    # --- Seguradoras & Corretoras de Seguros ---
    "BBSE3": "Seguradoras",
    "CXSE3": "Seguradoras",
    "IRBR3": "Seguradoras",
    "PSSA3": "Seguradoras",
    "WIZC3": "Seguradoras",
    "ALPK3": "Seguradoras",

    # --- Papel e Celulose ---
    "KLBN3": "Papel e Celulose",
    "KLBN4": "Papel e Celulose",
    "KLBN11": "Papel e Celulose",
    "SUZB3": "Papel e Celulose",
    "RANI3": "Papel e Celulose",
    "RANI4": "Papel e Celulose",

    # --- Energia Elétrica (Geração, Transmissão, Distribuição) ---
    "CMIG3": "Energia Elétrica",
    "CMIG4": "Energia Elétrica",
    "TAEE3": "Energia Elétrica",
    "TAEE4": "Energia Elétrica",
    "TAEE11": "Energia Elétrica",
    "ISAE3": "Energia Elétrica",
    "ISAE4": "Energia Elétrica",
    "TRPL3": "Energia Elétrica",
    "TRPL4": "Energia Elétrica",
    "ELET3": "Energia Elétrica",
    "ELET6": "Energia Elétrica",
    "AESB3": "Energia Elétrica",
    "AESB1": "Energia Elétrica",
    "EQTL3": "Energia Elétrica",
    "CPFE3": "Energia Elétrica",
    "ENGI3": "Energia Elétrica",
    "ENGI4": "Energia Elétrica",
    "ENGI11": "Energia Elétrica",
    "EGIE3": "Energia Elétrica",
    "NEOE3": "Energia Elétrica",
    "ALUP3": "Energia Elétrica",
    "ALUP4": "Energia Elétrica",
    "ALUP11": "Energia Elétrica",
    "AURE3": "Energia Elétrica",
    "ENEV3": "Energia Elétrica",
    "MEGA3": "Energia Elétrica",
    "CEBR3": "Energia Elétrica",

    # --- Saneamento Básico ---
    "SAPR3": "Saneamento",
    "SAPR4": "Saneamento",
    "SAPR11": "Saneamento",
    "CSMG3": "Saneamento",
    "SBSP3": "Saneamento",
    "AMBP3": "Saneamento",

    # --- Mineração e Siderurgia ---
    "VALE3": "Mineração e Siderurgia",
    "GGBR3": "Mineração e Siderurgia",
    "GGBR4": "Mineração e Siderurgia",
    "CSNA3": "Mineração e Siderurgia",
    "USIM3": "Mineração e Siderurgia",
    "USIM5": "Mineração e Siderurgia",
    "GOAU3": "Mineração e Siderurgia",
    "GOAU4": "Mineração e Siderurgia",
    "CBAV3": "Mineração e Siderurgia",
    "CMIN3": "Mineração e Siderurgia",

    # --- Petróleo, Gás e Combustíveis ---
    "PETR3": "Petróleo e Combustíveis",
    "PETR4": "Petróleo e Combustíveis",
    "PRIO3": "Petróleo e Combustíveis",
    "VBBR3": "Petróleo e Combustíveis",
    "UGPA3": "Petróleo e Combustíveis",
    "CSAN3": "Petróleo e Combustíveis",
    "RECV3": "Petróleo e Combustíveis",
    "BRAV3": "Petróleo e Combustíveis",
    "RRRP3": "Petróleo e Combustíveis",
    "ENAT3": "Petróleo e Combustíveis",
    "RAIZ4": "Petróleo e Combustíveis",

    # --- Automóveis e Autopeças ---
    "LEVE3": "Automóveis e Peças",
    "MYPK3": "Automóveis e Peças",
    "RAPT3": "Automóveis e Peças",
    "RAPT4": "Automóveis e Peças",
    "TUPY3": "Automóveis e Peças",
    "POMO3": "Automóveis e Peças",
    "POMO4": "Automóveis e Peças",
    "FRAS3": "Automóveis e Peças",
    "SHUL4": "Automóveis e Peças",

    # --- Telecomunicações ---
    "TIMS3": "Telecomunicações",
    "VIVT3": "Telecomunicações",
    "FIQE3": "Telecomunicações",
    "DESK3": "Telecomunicações",
    "BRIT3": "Telecomunicações",

    # --- Imobiliário, Construção & Shoppings (Ações) ---
    "ALOS3": "Imobiliário e Shoppings",
    "MULT3": "Imobiliário e Shoppings",
    "IGTI3": "Imobiliário e Shoppings",
    "IGTI11": "Imobiliário e Shoppings",
    "CYRE3": "Imobiliário e Shoppings",
    "EZTC3": "Imobiliário e Shoppings",
    "MRVE3": "Imobiliário e Shoppings",
    "DIRR3": "Imobiliário e Shoppings",
    "LAVV3": "Imobiliário e Shoppings",
    "CURY3": "Imobiliário e Shoppings",
    "TRIS3": "Imobiliário e Shoppings",
    "PLPL3": "Imobiliário e Shoppings",
    "JHSF3": "Imobiliário e Shoppings",
    "EVEN3": "Imobiliário e Shoppings",
    "TEND3": "Imobiliário e Shoppings",
    "HBOR3": "Imobiliário e Shoppings",

    # --- Comércio e Varejo ---
    "MGLU3": "Comércio e Varejo",
    "VIIA3": "Comércio e Varejo",
    "BHIA3": "Comércio e Varejo",
    "LREN3": "Comércio e Varejo",
    "ARZZ3": "Comércio e Varejo",
    "SOMA3": "Comércio e Varejo",
    "PETZ3": "Comércio e Varejo",
    "CRFB3": "Comércio e Varejo",
    "ASAI3": "Comércio e Varejo",
    "PCAR3": "Comércio e Varejo",
    "AMER3": "Comércio e Varejo",
    "CEAB3": "Comércio e Varejo",
    "GUAR3": "Comércio e Varejo",
    "SBFG3": "Comércio e Varejo",
    "ESPA3": "Comércio e Varejo",
    "LJQQ3": "Comércio e Varejo",

    # --- Alimentos e Bebidas ---
    "ABEV3": "Alimentos e Bebidas",
    "JBSS3": "Alimentos e Bebidas",
    "BRFS3": "Alimentos e Bebidas",
    "BEEF3": "Alimentos e Bebidas",
    "MRFG3": "Alimentos e Bebidas",
    "MDIA3": "Alimentos e Bebidas",
    "CAML3": "Alimentos e Bebidas",
    "SMTO3": "Alimentos e Bebidas",
    "SLCE3": "Alimentos e Bebidas",
    "AGRO3": "Alimentos e Bebidas",

    # --- Saúde, Farmácias e Medicina Diagnóstica ---
    "RDOR3": "Saúde e Farmácia",
    "FLRY3": "Saúde e Farmácia",
    "RADL3": "Saúde e Farmácia",
    "HAPV3": "Saúde e Farmácia",
    "ONCO3": "Saúde e Farmácia",
    "MATD3": "Saúde e Farmácia",
    "VVEO3": "Saúde e Farmácia",
    "BLAU3": "Saúde e Farmácia",
    "PGMN3": "Saúde e Farmácia",
    "PNVL3": "Saúde e Farmácia",
    "ODPV3": "Saúde e Farmácia",

    # --- Bens Industriais, Máquinas & Defesa ---
    "WEGE3": "Bens Industriais",
    "EMBR3": "Bens Industriais",
    "KEPL3": "Bens Industriais",
    "TASA3": "Bens Industriais",
    "TASA4": "Bens Industriais",
    "PTBL3": "Bens Industriais",
    "ROMI3": "Bens Industriais",

    # --- Logística, Transportes & Concessões ---
    "RAIL3": "Logística e Transportes",
    "RENT3": "Logística e Transportes",
    "CCRO3": "Logística e Transportes",
    "ECOR3": "Logística e Transportes",
    "STBP3": "Logística e Transportes",
    "JSLG3": "Logística e Transportes",
    "SIMH3": "Logística e Transportes",
    "VAMO3": "Logística e Transportes",
    "LOGN3": "Logística e Transportes",
    "TGMA3": "Logística e Transportes",
    "AZUL4": "Logística e Transportes",
    "GOLL4": "Logística e Transportes",

    # --- Serviços Financeiros e Bolsa ---
    "B3SA3": "Serviços Financeiros",
    "XPBR31": "Serviços Financeiros",
    "CIEL3": "Serviços Financeiros",
    "BRAP3": "Serviços Financeiros",
    "BRAP4": "Serviços Financeiros",

    # --- Tecnologia & Software ---
    "TOTS3": "Tecnologia",
    "POSI3": "Tecnologia",
    "LWSA3": "Tecnologia",
    "CASH3": "Tecnologia",
    "BMOB3": "Tecnologia",
    "INTB3": "Tecnologia",
    "MLAS3": "Tecnologia",

    # --- Fundos Imobiliários (FIIs) ---
    "HGLG11": "Imobiliário (Logística)",
    "HGLG12": "Imobiliário (Logística)",
    "BTLG11": "Imobiliário (Logística)",
    "XPLG11": "Imobiliário (Logística)",
    "VILG11": "Imobiliário (Logística)",
    "BRCO11": "Imobiliário (Logística)",
    "LVBI11": "Imobiliário (Logística)",
    "ALZR11": "Imobiliário (Logística)",
    "HGBS11": "Imobiliário (Shoppings)",
    "HGBS12": "Imobiliário (Shoppings)",
    "XPML11": "Imobiliário (Shoppings)",
    "VISC11": "Imobiliário (Shoppings)",
    "MALL11": "Imobiliário (Shoppings)",
    "HSML11": "Imobiliário (Shoppings)",
    "KNRI11": "Imobiliário (Híbrido)",
    "KNRI12": "Imobiliário (Híbrido)",
    "JSRE11": "Imobiliário (Híbrido)",
    "HGRE11": "Imobiliário (Lajes Corporativas)",
    "PVBI11": "Imobiliário (Lajes Corporativas)",
    "BRCR11": "Imobiliário (Lajes Corporativas)",
    "XPCI11": "Imobiliário (Papel / Recebíveis)",
    "PMIS11": "Imobiliário (Papel / Recebíveis)",
    "PMIS15": "Imobiliário (Papel / Recebíveis)",
    "KNCR11": "Imobiliário (Papel / Recebíveis)",
    "KNIP11": "Imobiliário (Papel / Recebíveis)",
    "MXRF11": "Imobiliário (Papel / Recebíveis)",
    "CPTS11": "Imobiliário (Papel / Recebíveis)",
    "HGCR11": "Imobiliário (Papel / Recebíveis)",
    "VRTA11": "Imobiliário (Papel / Recebíveis)",
    "RBRR11": "Imobiliário (Papel / Recebíveis)",
    "VGIR11": "Imobiliário (Papel / Recebíveis)",
    "KNSC11": "Imobiliário (Papel / Recebíveis)",
    "IRDM11": "Imobiliário (Papel / Recebíveis)",

    # --- Criptoativos ---
    "BTC": "Criptomoedas",
    "ETH": "Smart Contracts",
    "SOL": "Smart Contracts",
    "AAVE": "Finanças Descentralizadas (DeFi)",
    "PENDLE": "Finanças Descentralizadas (DeFi)",
    "USDT": "Stablecoins",
    "USDC": "Stablecoins",
    "ERA": "Web3 & Infraestrutura",
    "SXT": "Web3 & Infraestrutura",
}


def obter_setor_padrao(ticker: str, tipo: Optional[Any] = None) -> str:
    """Retorna o setor padrão de um ativo pelo ticker e/ou tipo de ativo."""
    if not ticker:
        return "Outros"

    ticker_limpo = ticker.strip().upper()

    # 1. Correspondência exata no dicionário consolidado
    if ticker_limpo in MAPA_SETORES_B3:
        return MAPA_SETORES_B3[ticker_limpo]

    # 2. Heurística para prefixos de Renda Fixa
    if ticker_limpo.startswith("TD-") or ticker_limpo.startswith("TESOURO"):
        return "Tesouro Direto"
    if ticker_limpo.startswith("CDB-") or ticker_limpo.startswith("CDB"):
        return "Títulos Bancários (CDB)"
    if ticker_limpo.startswith("LCI-") or ticker_limpo.startswith("LCA-"):
        return "Crédito Imobiliário / Agro"

    tipo_str = ""
    if tipo is not None:
        tipo_str = tipo.value if hasattr(tipo, "value") else str(tipo)
        tipo_str = tipo_str.upper()

    # 3. Heurística de FIIs na B3 (quando tipo for FII)
    if "FII" in tipo_str or "IMOBILIARIO" in tipo_str:
        return "Imobiliário"

    # 4. Heurística de Cripto
    if "CRIPTO" in tipo_str:
        return "Criptomoedas"

    # 5. Heurística de Renda Fixa genérica
    if "RENDA_FIXA" in tipo_str or "RENDAFIXA" in tipo_str:
        return "Renda Fixa"

    # 6. Fallback final
    return "Outros"
