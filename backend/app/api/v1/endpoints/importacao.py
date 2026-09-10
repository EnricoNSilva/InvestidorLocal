from typing import Dict, Any
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.ingestion.parser_b3 import processar_planilha_b3
from app.services.ingestion.parser_binance import processar_planilha_binance

router = APIRouter()

@router.post("/b3", summary="Upload e ingestão de negociações da B3 (.xlsx)")
async def upload_b3(
    file: UploadFile = File(..., description="Arquivo Excel (.xlsx) de negociações da B3"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Arquivo deve estar no formato Excel (.xlsx ou .xls)."
        )

    try:
        content = await file.read()
        transacoes = processar_planilha_b3(db=db, file_content=content)
        return {
            "status": "success",
            "origem": "B3",
            "filename": file.filename,
            "transacoes_processadas": len(transacoes),
            "mensagem": f"{len(transacoes)} transações da B3 importadas e consolidadas com sucesso."
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha da B3: {str(exc)}"
        )

@router.post("/binance", summary="Upload e ingestão de negociações da Binance (.xlsx)")
async def upload_binance(
    file: UploadFile = File(..., description="Arquivo Excel (.xlsx) da Binance com a aba 'Order History'"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Arquivo deve estar no formato Excel (.xlsx ou .xls)."
        )

    try:
        content = await file.read()
        transacoes = processar_planilha_binance(db=db, file_content=content)
        return {
            "status": "success",
            "origem": "Binance",
            "filename": file.filename,
            "transacoes_processadas": len(transacoes),
            "mensagem": f"{len(transacoes)} ordens da Binance processadas na fila cronológica única com PTAX."
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha da Binance: {str(exc)}"
        )
