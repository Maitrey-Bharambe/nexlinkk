# NexLink diagnostic service (Python)

Contracts and providers for AI-assisted diagnostics. Providers: `mock` (default, output labelled `[mock]`)
and `groq` (Groq chat completions in JSON mode — see "Using Groq" below).

```bash
python -m venv .venv && .venv/Scripts/activate      # or: source .venv/bin/activate
pip install -r requirements.txt
python -m pytest -q
uvicorn app.api.main:app --host 127.0.0.1 --port 8090
```

Enable from the control plane with `DIAGNOSTIC_SERVICE_URL=http://127.0.0.1:8090`, then run diagnostics
with `{"mode":"diagnostic_service"}`.

* `app/schemas` — request/response models (strict; no confidence field)
* `app/providers` — `Provider` protocol, `MockProvider`, selection via `NEXLINK_DIAG_PROVIDER`
* `app/validators` — evidence grounding + action allowlist
* `app/planners` — runs a provider and enforces the contract
* `app/api` — FastAPI app

Defence in depth: whatever this service returns is re-validated by the control plane, every proposed action
goes through the policy engine and human approval, and the agent enforces its own allowlist. VPN
connectivity never depends on this service.

## Using Groq

```powershell
$env:NEXLINK_DIAG_PROVIDER = "groq"
$env:GROQ_API_KEY = "<your key from console.groq.com>"   # never commit it
# optional: $env:GROQ_MODEL = "llama-3.3-70b-versatile"
.venv\Scripts\python -m uvicorn app.api.main:app --host 127.0.0.1 --port 8090
```

Then set `DIAGNOSTIC_SERVICE_URL=http://127.0.0.1:8090` in `control-plane/.env` and use **ask ai** on an
incident. Only evidence refs, kinds, summaries and timestamps are sent to Groq — never raw evidence data
(IP addresses, endpoints). Responses that cite unknown evidence, use non-allowlisted actions or add
confidence scores are rejected, and every proposed action still goes through the policy engine and needs
human approval. VPN connectivity never depends on Groq being reachable.
