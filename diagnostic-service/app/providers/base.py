"""Provider interface for diagnostic planning.

A provider turns (incident, evidence, tool list, allowed actions) into a raw
dict shaped like DiagnosticResult. Providers are swappable via
NEXLINK_DIAG_PROVIDER; the networking core never depends on any of them.

Implemented:
  mock — deterministic, rule-based; output is labelled "mock" so it is never
         mistaken for model analysis.
  groq — Groq chat completions in JSON mode (app/providers/groq.py).
"""

from __future__ import annotations

import os
from typing import Any, Protocol

from app.schemas.diagnostic import DiagnoseRequest


class Provider(Protocol):
    name: str

    def plan(self, request: DiagnoseRequest) -> dict[str, Any]:
        """Return a raw result dict. It will be schema- and grounding-validated."""
        ...


class ProviderNotConfigured(RuntimeError):
    pass


class MockProvider:
    """Deterministic stand-in used for contract tests and local development."""

    name = "mock"

    def plan(self, request: DiagnoseRequest) -> dict[str, Any]:
        inc = request.incident
        ev = request.evidence
        refs = [e.ref for e in ev][:5]
        allowed = {a.id for a in request.allowed_actions}
        observations = [{"statement": f"[mock] {e.summary}", "evidence_refs": [e.ref]} for e in ev[:3]]
        actions = []
        if "request_peer_status_report" in allowed and inc.category != "agent_offline":
            actions.append(
                {"action_type": "request_peer_status_report", "params": {}, "rationale": "[mock] refresh WireGuard peer state before acting"}
            )
        return {
            "incident_id": inc.id,
            "summary": f"[mock provider] {inc.title}. Not a model analysis.",
            "observations": observations,
            "hypotheses": [{"statement": "[mock] placeholder hypothesis", "status": "untested", "supporting_refs": refs[:1]}],
            "evidence": refs,
            "uncertainties": ["Mock provider: no reasoning performed."],
            "proposed_actions": actions,
            "requires_human_approval": True,
        }


def get_provider() -> Provider:
    name = os.environ.get("NEXLINK_DIAG_PROVIDER", "mock")
    if name == "mock":
        return MockProvider()
    if name == "groq":
        from app.providers.groq import from_env

        provider = from_env()
        if provider is None:
            raise ProviderNotConfigured("NEXLINK_DIAG_PROVIDER=groq but GROQ_API_KEY is not set")
        return provider
    raise ProviderNotConfigured(f"unknown provider {name!r} (supported: mock, groq)")
