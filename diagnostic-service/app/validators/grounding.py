"""Grounding and allowlist validation for planner output.

A provider (rules or an LLM) may only cite evidence that the control plane's
read-only tools actually collected, and may only propose allowlisted actions.
This is a first filter; the control plane's policy engine is authoritative.
"""

from __future__ import annotations

from app.schemas.diagnostic import DiagnoseRequest, DiagnosticResult


class ValidationFailure(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors[:5]))
        self.errors = errors


def validate_result(result: DiagnosticResult, request: DiagnoseRequest) -> DiagnosticResult:
    known = {e.ref for e in request.evidence}
    allowed = {a.id for a in request.allowed_actions}
    errors: list[str] = []

    if result.incident_id != request.incident.id:
        errors.append("incident_id does not match request")
    for i, obs in enumerate(result.observations):
        for ref in obs.evidence_refs:
            if ref not in known:
                errors.append(f"observations[{i}] cites unknown evidence {ref!r}")
    for i, hyp in enumerate(result.hypotheses):
        for ref in hyp.supporting_refs:
            if ref not in known:
                errors.append(f"hypotheses[{i}] cites unknown evidence {ref!r}")
    for ref in result.evidence:
        if ref not in known:
            errors.append(f"evidence lists unknown ref {ref!r}")
    for i, act in enumerate(result.proposed_actions):
        if act.action_type not in allowed:
            errors.append(f"proposed_actions[{i}] uses non-allowlisted action {act.action_type!r}")

    if errors:
        raise ValidationFailure(errors)
    return result
