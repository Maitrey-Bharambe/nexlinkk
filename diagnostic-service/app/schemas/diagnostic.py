"""Data contracts between the control plane and the diagnostic service.

These mirror control-plane/src/modules/diagnostics/diagnostic.schema.js. The
control plane re-validates every response, so this service cannot widen what
is accepted — it can only be stricter.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---- request (incident ingestion + collected evidence) ----


class DeviceRef(Strict):
    id: str
    name: str


class IncidentIn(Strict):
    id: str
    category: str
    severity: Literal["low", "medium", "high"]
    title: str
    detected_at: datetime
    device: DeviceRef


class EvidenceItem(Strict):
    ref: str = Field(max_length=200)
    kind: str
    summary: str
    observed_at: datetime | None = None
    data: Any = None


class ToolInfo(Strict):
    name: str
    description: str
    readOnly: bool = True


class AllowedAction(Strict):
    id: str
    description: str
    risk: Literal["low", "medium", "high"]


class DiagnoseRequest(Strict):
    incident: IncidentIn
    evidence: list[EvidenceItem] = Field(max_length=500)
    tools: list[ToolInfo]
    allowed_actions: list[AllowedAction]


# ---- response (structured diagnostic result) ----


class Observation(Strict):
    statement: str = Field(min_length=1, max_length=500)
    evidence_refs: list[str] = Field(min_length=1, max_length=20)


class Hypothesis(Strict):
    statement: str = Field(min_length=1, max_length=500)
    status: Literal["plausible", "ruled_out", "untested"]
    supporting_refs: list[str] = Field(max_length=20)


class ProposedAction(Strict):
    action_type: str = Field(max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)
    rationale: str = Field(min_length=1, max_length=500)


class DiagnosticResult(Strict):
    """No confidence field by design: uncalibrated scores are not accepted."""

    incident_id: str
    summary: str = Field(min_length=1, max_length=1000)
    observations: list[Observation] = Field(max_length=30)
    hypotheses: list[Hypothesis] = Field(max_length=15)
    evidence: list[str] = Field(max_length=100)
    uncertainties: list[str] = Field(max_length=20)
    proposed_actions: list[ProposedAction] = Field(max_length=5)
    requires_human_approval: Literal[True] = True


class DiagnoseResponse(Strict):
    provider: str
    result: DiagnosticResult
