from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.db.session import get_db

router = APIRouter()

@router.get("/health", summary="Health Check do Backend e SQLite")
def health_check(db: Session = Depends(get_db)):
    try:
        # Executa consulta simples para testar conexão com o banco
        result = db.execute(text("SELECT 1")).scalar()
        db_status = "connected" if result == 1 else "unexpected_result"
    except Exception as exc:
        db_status = f"error: {str(exc)}"

    return {
        "status": "healthy" if db_status == "connected" else "unhealthy",
        "database": db_status,
        "detail": "Meu Investidor Local API operando normalmente"
    }
