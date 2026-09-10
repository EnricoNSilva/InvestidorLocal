from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.ingestion.parser_b3 import processar_planilha_b3
from app.services.ingestion.parser_binance import processar_planilha_binance
from app.services.ingestion.parser_movimentacao_b3 import processar_planilha_movimentacao_b3

router = APIRouter()

@router.post("/b3", summary="Upload e ingestão de negociações da B3 (.xlsx)")
async def upload_b3(
    file: UploadFile = File(..., description="Arquivo Excel (.xlsx) de negociações da B3"),
    carteira_id: Optional[int] = Query(default=1, description="ID da carteira de destino"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Arquivo deve estar no formato Excel (.xlsx ou .xls)."
        )

    try:
        content = await file.read()
        transacoes, pendencias = processar_planilha_b3(db=db, file_content=content, carteira_id=carteira_id)
        return {
            "status": "success",
            "origem": "B3",
            "filename": file.filename,
            "carteira_id": carteira_id,
            "transacoes_processadas": len(transacoes),
            "pendencias": pendencias,
            "mensagem": f"{len(transacoes)} transações da B3 importadas com sucesso. {len(pendencias)} pendências detectadas."
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha da B3: {str(exc)}"
        )

@router.post("/b3-transferencias", summary="Upload e ingestão de transferências/movimentações de custódia da B3 (.xlsx)")
async def upload_b3_transferencias(
    file: UploadFile = File(..., description="Arquivo Excel (.xlsx) de movimentação/custódia da B3"),
    carteira_id: Optional[int] = Query(default=1, description="ID da carteira de destino"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Arquivo deve estar no formato Excel (.xlsx ou .xls)."
        )

    try:
        content = await file.read()
        resultado = processar_planilha_movimentacao_b3(db=db, file_content=content, carteira_id=carteira_id)
        transacoes = resultado["transacoes"]
        avisos = resultado["avisos"]
        return {
            "status": "success",
            "origem": "B3-Transferencias",
            "filename": file.filename,
            "carteira_id": carteira_id,
            "transferencias_processadas": len(transacoes),
            "avisos": avisos,
            "mensagem": f"{len(transacoes)} entradas/transferências de custódia consolidadas com sucesso."
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha de movimentações da B3: {str(exc)}"
        )

@router.post("/binance", summary="Upload e ingestão de negociações da Binance (.xlsx)")
async def upload_binance(
    file: UploadFile = File(..., description="Arquivo Excel (.xlsx) da Binance com a aba 'Order History'"),
    carteira_id: Optional[int] = Query(default=1, description="ID da carteira de destino"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Arquivo deve estar no formato Excel (.xlsx ou .xls)."
        )

    try:
        content = await file.read()
        resultado = processar_planilha_binance(db=db, file_content=content, carteira_id=carteira_id)
        transacoes = resultado["transacoes"]
        pendencias = resultado["pendencias"]
        aba = resultado.get("aba_processada", "Order History")
        return {
            "status": "success",
            "origem": "Binance",
            "filename": file.filename,
            "carteira_id": carteira_id,
            "transacoes_processadas": len(transacoes),
            "pendencias": pendencias,
            "mensagem": f"{len(transacoes)} ordens da Binance processadas com sucesso a partir da aba '{aba}'." + (f" {len(pendencias)} pendências detectadas." if pendencias else "")
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha da Binance: {str(exc)}"
        )
