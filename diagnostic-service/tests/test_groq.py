"""Groq provider tests. No network: httpx.MockTransport stands in for Groq."""

import json

import httpx
import pytest

from app.planners.planner import diagnose
from app.providers.base import ProviderNotConfigured, get_provider
from app.providers.groq import GroqProvider, ProviderError
from app.schemas.diagnostic import DiagnoseRequest
from app.validators.grounding import ValidationFailure
from tests.test_contracts import REQUEST

KEY = "gsk_test_secret_value"


def provider_returning(content, status=200, seen=None):
    def handler(request: httpx.Request):
        if seen is not None:
            seen.append(request)
        if status != 200:
            return httpx.Response(status, json={"error": {"message": f"bad key {KEY}"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return GroqProvider(api_key=KEY, model="llama-3.3-70b-versatile", base_url="https://api.groq.test/openai/v1", client=client)


GOOD = {
    "incident_id": "inc1",
    "summary": "Interface reported down by WireGuard.",
    "observations": [{"statement": "nx0 reported down", "evidence_refs": ["device:dev1:vpn"]}],
    "hypotheses": [{"statement": "Tunnel service stopped", "status": "untested", "supporting_refs": ["device:dev1:vpn"]}],
    "evidence": ["device:dev1:vpn"],
    "uncertainties": ["Single report."],
    "proposed_actions": [{"action_type": "request_peer_status_report", "params": {}, "rationale": "Fresh read first"}],
    "requires_human_approval": True,
}


def req():
    return DiagnoseRequest.model_validate(REQUEST)


def test_grounded_groq_output_passes_and_request_is_shaped_correctly():
    seen = []
    out = diagnose(req(), provider_returning(json.dumps(GOOD), seen=seen))
    assert out.provider == "groq:llama-3.3-70b-versatile"
    assert out.result.proposed_actions[0].action_type == "request_peer_status_report"
    sent = seen[0]
    assert sent.url.path.endswith("/chat/completions")
    assert sent.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(sent.content)
    assert body["response_format"] == {"type": "json_object"}
    # Raw evidence `data` is never sent to the provider.
    assert all("data" not in e for e in json.loads(body["messages"][1]["content"])["evidence"])


@pytest.mark.parametrize(
    "patch",
    [
        {"observations": [{"statement": "rtt 900ms", "evidence_refs": ["measurement:hallucinated"]}]},
        {"proposed_actions": [{"action_type": "reboot_host", "params": {}, "rationale": "x"}]},
        {"confidence": 0.93},
    ],
)
def test_hallucinated_or_unsafe_groq_output_is_rejected(patch):
    with pytest.raises(ValidationFailure):
        diagnose(req(), provider_returning(json.dumps({**GOOD, **patch})))


def test_non_json_completion_is_a_provider_error():
    with pytest.raises(ProviderError):
        diagnose(req(), provider_returning("Sure! Here is my analysis..."))


def test_upstream_error_never_leaks_the_key():
    with pytest.raises(ProviderError) as exc:
        diagnose(req(), provider_returning("", status=401))
    assert KEY not in str(exc.value)
    assert "401" in str(exc.value)


def test_groq_selected_without_key_is_not_configured(monkeypatch):
    monkeypatch.setenv("NEXLINK_DIAG_PROVIDER", "groq")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(ProviderNotConfigured):
        get_provider()
    monkeypatch.setenv("GROQ_API_KEY", KEY)
    assert get_provider().name.startswith("groq:")
