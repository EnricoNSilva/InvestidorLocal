from pathlib import Path
from pydantic_settings import BaseSettings

# Diretório base do backend: C:\InvestidorLocal\backend
BACKEND_DIR = Path(__file__).resolve().parent.parent.parent

class Settings(BaseSettings):
    PROJECT_NAME: str = "Meu Investidor Local"
    API_V1_STR: str = "/api/v1"

    # Caminho padrão do banco de dados SQLite local
    DATABASE_PATH: Path = BACKEND_DIR / "investimentos.db"
    SQLITE_URL: str = f"sqlite:///{DATABASE_PATH.as_posix()}"

    # CORS: origens permitidas (incluindo Angular local padrão http://localhost:4200)
    BACKEND_CORS_ORIGINS: list[str] = [
        "http://localhost:4200",
        "http://127.0.0.1:4200",
        "http://localhost:3000",
    ]

    class Config:
        case_sensitive = True

settings = Settings()
