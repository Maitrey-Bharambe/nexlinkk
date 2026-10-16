"""Runs a provider and enforces the output contract."""

from __future__ import annotations

from pydantic import ValidationError

from app.providers.base import Provider
from app.schemas.diagnostic import DiagnoseRequest, DiagnoseResponse, DiagnosticResult
from app.validators.grounding import ValidationFailure, validate_result


def diagnose(request: DiagnoseRequest, provider: Provider) -> DiagnoseResponse:
    raw = provider.plan(request)
    try:
        result = DiagnosticResult.model_validate(raw)
    except ValidationError as exc:
        raise ValidationFailure([f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()]) from exc
    return DiagnoseResponse(provider=provider.name, result=validate_result(result, request))
