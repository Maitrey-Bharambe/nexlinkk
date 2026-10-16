from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api.main import app
from app.planners.planner import diagnose
from app.schemas.diagnostic import DiagnoseRequest
from app.validators.grounding import ValidationFailure

REQUEST = {
    "incident": {
        "id": "inc1",
        "category": "vpn_interface_down",
        "severity": "medium",
        "title": "box: WireGuard interface down",
        "detected_at": datetime.now(timezone.utc).isoformat(),
        "device": {"id": "dev1", "name": "box"},
    },
    "evidence": [
        {"ref": "device:dev1:vpn", "kind": "vpn_interface", "summary": "Interface nx0 reported down via wgctrl"},
        {"ref": "heartbeat:h1", "kind": "heartbeat", "summary": "seq 4 health=ok vpn=down"},
    ],
    "tools": [{"name": "get_device_status", "description": "x", "readOnly": True}],
    "allowed_actions": [{"id": "request_peer_status_report", "description": "x", "risk": "low"}],
}

client = TestClient(app)


def test_mock_provider_output_is_grounded_and_labelled():
    res = client.post("/v1/diagnose", json=REQUEST)
    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "mock"
    result = body["result"]
    assert result["requires_human_approval"] is True
    assert "[mock" in result["summary"]
    known = {e["ref"] for e in REQUEST["evidence"]}
    assert all(r in known for o in result["observations"] for r in o["evidence_refs"])


def test_unknown_request_fields_rejected():
    bad = {**REQUEST, "shell": "rm -rf /"}
    assert client.post("/v1/diagnose", json=bad).status_code == 422


class _Rogue:
    name = "rogue"

    def __init__(self, patch):
        self.patch = patch

    def plan(self, request):
        base = {
            "incident_id": request.incident.id,
            "summary": "s",
            "observations": [{"statement": "x", "evidence_refs": ["device:dev1:vpn"]}],
            "hypotheses": [],
            "evidence": ["device:dev1:vpn"],
            "uncertainties": [],
            "proposed_actions": [],
            "requires_human_approval": True,
        }
        base.update(self.patch)
        return base


@pytest.mark.parametrize(
    "patch",
    [
        {"observations": [{"statement": "x", "evidence_refs": ["measurement:invented"]}]},
        {"proposed_actions": [{"action_type": "run_shell", "params": {"cmd": "id"}, "rationale": "r"}]},
        {"confidence": 0.99},
        {"requires_human_approval": False},
        {"incident_id": "other"},
    ],
)
def test_rogue_provider_output_rejected(patch):
    with pytest.raises(ValidationFailure):
        diagnose(DiagnoseRequest.model_validate(REQUEST), _Rogue(patch))


def test_valid_rogue_baseline_passes():
    out = diagnose(DiagnoseRequest.model_validate(REQUEST), _Rogue({}))
    assert out.result.incident_id == "inc1"
