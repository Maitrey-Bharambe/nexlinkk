"""Groq provider (OpenAI-compatible chat completions, JSON mode).

Configuration (environment only — the key is never logged or returned):
  GROQ_API_KEY    required
  GROQ_MODEL      default "llama-3.3-70b-versatile"
  GROQ_BASE_URL   default "https://api.groq.com/openai/v1"

Privacy: only evidence ref/kind/summary/timestamp are sent, never the raw
`data` payloads (which can contain IP addresses and endpoints).
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from app.schemas.diagnostic import DiagnoseRequest

SYSTEM_PROMPT = """You are the diagnostic planner for NexLink, a WireGuard private-network platform.
You receive one incident, the evidence collected by read-only tools, and an allowlist of actions.

Return ONE JSON object with exactly these keys and nothing else:
{
  "incident_id": string (copy from input),
  "summary": string (<= 3 sentences),
  "observations": [{"statement": string, "evidence_refs": [ref, ...]}],
  "hypotheses": [{"statement": string, "status": "plausible"|"ruled_out"|"untested", "supporting_refs": [ref, ...]}],
  "evidence": [ref, ...],
  "uncertainties": [string, ...],
  "proposed_actions": [{"action_type": allowlisted id, "params": object, "rationale": string}],
  "requires_human_approval": true
}

Rules:
- Observations state only what an evidence item says, and every observation cites >= 1 ref copied exactly from the evidence list.
- Hypotheses are possible causes, not facts. Use "untested" unless evidence directly supports or rules them out.
- Never invent refs, measurements, devices or actions. Use only action ids from the allowlist; at most 3 actions.
- Params for run_connectivity_test: {"target": "control_plane"} or {"target": "peer", "peerDeviceId": "<24-hex id from evidence>"}, optional "count" 1..20. Other actions take {}.
- A failed ping/TCP probe does not prove a host is down. Say so in uncertainties when relevant.
- If evidence is insufficient, say so in uncertainties and propose read-only checks.
- Do not include confidence scores or probabilities.
"""


class ProviderError(RuntimeError):
    """Upstream failure. Messages never include the API key."""


class GroqProvider:
    name = "groq"

    def __init__(self, api_key: str, model: str, base_url: str, client: httpx.Client | None = None, timeout: float = 20.0):
        self._key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=timeout)
        self.name = f"groq:{model}"

    def _payload(self, request: DiagnoseRequest) -> dict[str, Any]:
        user = {
            "incident": request.incident.model_dump(mode="json"),
            "evidence": [
                {"ref": e.ref, "kind": e.kind, "summary": e.summary, "observed_at": e.observed_at.isoformat() if e.observed_at else None}
                for e in request.evidence[:80]
            ],
            "allowed_actions": [a.model_dump() for a in request.allowed_actions],
        }
        return {
            "model": self.model,
            "temperature": 0.1,
            "max_tokens": 1500,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(user)},
            ],
        }

    def plan(self, request: DiagnoseRequest) -> dict[str, Any]:
        try:
            res = self._client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"},
                json=self._payload(request),
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"groq request failed: {type(exc).__name__}") from None
        if res.status_code != 200:
            # Body may echo request details; keep only the status and a short, key-free message.
            detail = ""
            try:
                detail = str(res.json().get("error", {}).get("message", ""))[:200]
            except ValueError:
                pass
            raise ProviderError(f"groq HTTP {res.status_code}: {detail.replace(self._key, '[REDACTED]')}")
        try:
            content = res.json()["choices"][0]["message"]["content"]
            out = json.loads(content)
        except (ValueError, KeyError, IndexError, TypeError):
            raise ProviderError("groq returned a non-JSON or malformed completion") from None
        if not isinstance(out, dict):
            raise ProviderError("groq completion is not a JSON object")
        return out


def from_env() -> GroqProvider | None:
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        return None
    return GroqProvider(
        api_key=key,
        model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
        base_url=os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
    )
