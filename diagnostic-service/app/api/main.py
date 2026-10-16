"""HTTP API. Bind to loopback (or a private network) only; the control plane is
the sole intended caller and re-validates everything this service returns."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.planners.planner import diagnose
from app.providers.base import ProviderNotConfigured, get_provider
from app.providers.groq import ProviderError
from app.schemas.diagnostic import DiagnoseRequest
from app.validators.grounding import ValidationFailure

app = FastAPI(title="NexLink diagnostic service", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict:
    try:
        return {"ok": True, "provider": get_provider().name}
    except ProviderNotConfigured as exc:
        return {"ok": False, "provider": None, "error": str(exc)}


@app.post("/v1/diagnose")
def post_diagnose(request: DiagnoseRequest):
    try:
        provider = get_provider()
    except ProviderNotConfigured as exc:
        return JSONResponse(status_code=503, content={"ok": False, "error": {"code": "PROVIDER_NOT_CONFIGURED", "message": str(exc)}})
    try:
        return diagnose(request, provider).model_dump(mode="json")
    except ProviderError as exc:
        return JSONResponse(status_code=502, content={"ok": False, "error": {"code": "PROVIDER_ERROR", "message": str(exc)}})
    except ValidationFailure as exc:
        return JSONResponse(status_code=422, content={"ok": False, "error": {"code": "PROVIDER_OUTPUT_REJECTED", "message": str(exc), "details": exc.errors[:20]}})
