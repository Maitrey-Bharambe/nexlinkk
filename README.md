<div align="center">

# 🟢 NexLink

**Private networking · evidence-based diagnostics · policy-gated remote ops**

*WireGuard tunnels, honest telemetry, and diagnostics that show their receipts.<br/>Nothing is marked connected until a handshake says so.*

![Next.js](https://img.shields.io/badge/Next.js_15-0F0F0F?style=for-the-badge&logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Tailwind](https://img.shields.io/badge/Tailwind_v4-0F172A?style=for-the-badge&logo=tailwindcss&logoColor=38BDF8)
![Node.js](https://img.shields.io/badge/Node.js_22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-010101?style=for-the-badge&logo=socketdotio&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)
![Go](https://img.shields.io/badge/Go_1.27-00ADD8?style=for-the-badge&logo=go&logoColor=white)
![WireGuard](https://img.shields.io/badge/WireGuard-88171A?style=for-the-badge&logo=wireguard&logoColor=white)
![Python](https://img.shields.io/badge/Python_3.13-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Groq](https://img.shields.io/badge/Groq_LLM-F55036?style=for-the-badge&logoColor=white)

![tests](https://img.shields.io/badge/tests-90_passing-C7FF2E?style=flat-square&labelColor=0F0F0F)
![control plane](https://img.shields.io/badge/control--plane-57%2F57-C7FF2E?style=flat-square&labelColor=2E2E2E)
![agent](https://img.shields.io/badge/go--agent-18%2F18_%2B_integration-C7FF2E?style=flat-square&labelColor=2E2E2E)
![diagnostics](https://img.shields.io/badge/diagnostic--service-15%2F15-C7FF2E?style=flat-square&labelColor=2E2E2E)
![stage](https://img.shields.io/badge/stage-foundation-FFFFFF?style=flat-square&labelColor=0F0F0F)
![two-pc tunnel](https://img.shields.io/badge/two--PC_tunnel-pending-808080?style=flat-square&labelColor=0F0F0F)

</div>

---

## 📑 Contents

[Overview](#-overview) · [Status](#-project-status) · [Architecture](#%EF%B8%8F-architecture) · [How it works](#-how-it-works) · [Quick start](#-quick-start) · [Testing](#-testing) · [Security](#-security-model) · [Repository](#-repository-layout) · [Docs](#-documentation) · [Roadmap](#%EF%B8%8F-roadmap)

## ✨ Overview

NexLink lets you create private networks, enroll your own computers, watch real connectivity, diagnose
failures, and run **approved** remote actions from a web console.

| | |
|---|---|
| 🔐 **Real VPN, not a dashboard** | Devices talk over **WireGuard**. The web server never carries tunnel traffic — control plane and data plane are separate. |
| 🧾 **Honest state** | Agent liveness, interface state and tunnel handshakes are tracked **separately**. Missing data shows as *unknown / not measured* — never as `0` or "healthy". |
| 🧠 **AI with guardrails** | Diagnostics (rules or **Groq LLM**) must cite real evidence, can only propose allowlisted actions, and every action needs policy checks **and** a human yes. |
| 📜 **Audited** | Every security-sensitive operation is written to an append-only audit log by the backend. |

## 📊 Project status

> **Legend:** ✅ done & tested  ·  🟡 built, partially verified  ·  ⏳ ready, waiting on a manual run  ·  ❌ not started

| Area | Status | Evidence |
|---|:---:|---|
| 🔑 Login, HttpOnly sessions, CSRF, lockout, RBAC (admin / operator / viewer), scoped access | ✅ | `control-plane/tests/auth.test.js` |
| 🙋 Self-service **sign up** + **register this PC** onboarding | ✅ | `signup.test.js` + browser check |
| 🌐 Networks: CIDR validation, overlap rejection (incl. races), DB-enforced unique addresses | ✅ | `networks.test.js`, `ipv4.test.js` |
| 🪪 Enrollment: one-time hashed tokens, Ed25519 proof-of-possession, replay/expiry/duplicate rejection, revocation | ✅ | `enrollment.test.js` |
| ✍️ Signed agent protocol (timestamp window, nonce replay guard, body integrity) | ✅ | Node tests + Go↔Node signature test vector |
| 💓 Heartbeats, telemetry schema v1, health model, observed-vs-configured topology | ✅ | `telemetry.test.js` |
| 🩺 Incident detection → evidence → diagnosis → policy → approval → execution → verification | ✅ | `incidents.test.js` |
| 📜 Append-only audit log (searchable) | ✅ | `incidents.test.js`, `auth.test.js` |
| 🖥️ Next.js console (overview, networks, devices, topology, diagnostics, approvals, audit, setup) | ✅ | production build + browser walkthrough |
| 🐹 Go agent: enroll, heartbeat, telemetry, TCP probes, command executor, WireGuard inspector/applier | ✅ | 18 Go tests + live integration test |
| 🧰 `export-config`, `doctor`, tunnel probe responder, LAN endpoint ranking | 🟡 | verified with two agents on one PC |
| 🔗 Real WireGuard tunnel between **two PCs** | ⏳ | follow [docs/two-pc-test.md](docs/two-pc-test.md) |
| 🤖 Groq LLM diagnostics ("ask ai") | 🟡 | 15 Python tests with mocked Groq; live call needs your `GROQ_API_KEY` |
| 🛰️ NAT traversal / relay fallback | ❌ | designed in [docs/network-protocols.md](docs/network-protocols.md) |
| 🔒 TLS deployment guide, OS keychain key storage, MFA | ❌ | [roadmap](#%EF%B8%8F-roadmap) |

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph OP["👩‍💻 Operator"]
        B["Browser<br/>NexLink console"]
    end

    subgraph WEB["🖥️ Web tier"]
        FE["Next.js :3000<br/>/api/v1 rewrite"]
    end

    subgraph CP["🧭 Control plane — coordination only"]
        API["Express API :4000<br/>sessions · RBAC · CSRF"]
        AG["Agent API<br/>Ed25519-signed requests"]
        DET["Incident detector"]
        POL["Policy engine<br/>action allowlist"]
        AUD["Audit log"]
        DB[("MongoDB")]
    end

    subgraph AI["🤖 AI layer — optional"]
        DS["Diagnostic service<br/>FastAPI :8090"]
        LLM["Groq LLM"]
    end

    subgraph DP["🔐 Data plane — WireGuard"]
        A1["PC-1<br/>nexlink-agent"]
        A2["PC-2<br/>nexlink-agent"]
    end

    B -->|"HTTPS + cookie"| FE --> API
    B <-.->|"Socket.IO ids only"| API
    API --- DB
    AG --- DB
    API --> POL --> AUD
    DET --> DB
    API -->|"summaries"| DS --> LLM
    A1 -->|"heartbeat · telemetry"| AG
    A2 -->|"heartbeat · telemetry"| AG
    A1 <==>|"UDP 51820 encrypted tunnel"| A2

    classDef lime fill:#C7FF2E,stroke:#0F0F0F,color:#0F0F0F,stroke-width:2px
    classDef ink fill:#0F0F0F,stroke:#C7FF2E,color:#FFFFFF,stroke-width:1px
    classDef char fill:#2E2E2E,stroke:#808080,color:#FFFFFF
    classDef white fill:#FFFFFF,stroke:#0F0F0F,color:#0F0F0F
    classDef ai fill:#F55036,stroke:#0F0F0F,color:#FFFFFF
    classDef db fill:#47A248,stroke:#0F0F0F,color:#FFFFFF
    class A1,A2 lime
    class API,AG,DET,POL,AUD ink
    class B,FE white
    class DS,LLM ai
    class DB db
    style DP fill:#1A1F0A,stroke:#C7FF2E,color:#C7FF2E
    style CP fill:#161616,stroke:#808080,color:#FFFFFF
    style AI fill:#2A1410,stroke:#F55036,color:#F55036
    style WEB fill:#161616,stroke:#808080,color:#FFFFFF
    style OP fill:#161616,stroke:#808080,color:#FFFFFF
```

> The thick lime link is the **only** path VPN packets take. The control plane coordinates keys, addresses
> and policy — it never sees tunnel traffic.

### Five layers of "is it connected?"

| Layer | Meaning | Evidence |
|---|---|---|
| 1️⃣ Registered | identity key enrolled | `devices.enrollmentState = enrolled` |
| 2️⃣ Configured | desired peers computed | `networks.configVersion`, `GET /agent/config` |
| 3️⃣ Tunnel up | WireGuard completed a handshake | last handshake ≤ 180 s at report time |
| 4️⃣ Reachable | packets cross the tunnel | TCP probe to the peer's tunnel address |
| 5️⃣ App works | a service on the peer answers | *not measured yet* |

None of these is inferred from the one above it.

## 🔄 How it works

### 🪪 Enrolling a PC

```mermaid
sequenceDiagram
    autonumber
    actor U as 👩‍💻 You
    participant C as 🖥️ Console
    participant P as 🧭 Control plane
    participant A as 🐹 Agent on your PC

    U->>C: sign up · register this pc
    C->>P: POST /onboarding/register-device
    P-->>C: one-time token (15 min, stored hashed)
    U->>A: nexlink-agent enroll (paste token)
    rect rgba(199, 255, 46, 0.18)
        Note over A: generates Ed25519 identity key<br/>+ WireGuard key locally
        A->>P: token + public keys + signature (proof of possession)
    end
    P->>P: verify signature · consume token atomically · allocate 10.x.0.y
    P-->>A: deviceId + tunnel address
    P-->>C: Socket.IO device update
    C-->>U: "my-pc is in."
    loop every 30 s
        A->>P: signed heartbeat + telemetry
    end
```

### 🚦 Peer link states (what the topology draws)

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Configured: both devices active
    Configured --> Connecting: peer on interface, no handshake
    Connecting --> Connected: fresh handshake
    Connected --> Degraded: loss over 5% or RTT over 250 ms
    Degraded --> Connected: metrics recover
    Connected --> Unreachable: handshake older than 180 s
    Unreachable --> Connected: new handshake
    Connected --> Unknown: reports stale
    Unknown --> Connected: fresh report

    classDef good fill:#C7FF2E,color:#0F0F0F,stroke:#0F0F0F
    classDef warn fill:#FFFFFF,color:#0F0F0F,stroke:#C7FF2E
    classDef bad fill:#FF5A36,color:#FFFFFF,stroke:#0F0F0F
    classDef none fill:#2E2E2E,color:#FFFFFF,stroke:#808080
    class Connected good
    class Degraded,Connecting warn
    class Unreachable bad
    class Configured,Unknown none
```

### 🩺 Diagnostic loop with human-in-the-loop

```mermaid
flowchart TD
    O["👀 Observe<br/>detector every 30 s"] --> C["🏷️ Classify<br/>incident category"]
    C --> E["🔎 Gather evidence<br/>read-only tools"]
    E --> H{"🧠 Planner"}
    H -->|"deterministic rules"| R["Structured result"]
    H -->|"ask ai · Groq"| G["Structured result"]
    R --> V["✅ Validate<br/>schema + evidence refs"]
    G --> V
    V -->|"invented evidence / unknown action"| X["⛔ Rejected"]
    V --> P["🛡️ Policy engine<br/>allowlist · params · state · rate limit"]
    P -->|"fails"| X
    P --> HU{"🙋 Human approval"}
    HU -->|"reject"| X
    HU -->|"approve · policy re-checked"| AG["🐹 Agent executes<br/>agent-side allowlist"]
    AG --> VF["📏 Verify from fresh measurements"]
    VF --> RS["Incident resolved only if<br/>the detector sees it cleared"]

    classDef lime fill:#C7FF2E,color:#0F0F0F,stroke:#0F0F0F,stroke-width:2px
    classDef ink fill:#0F0F0F,color:#FFFFFF,stroke:#C7FF2E
    classDef white fill:#FFFFFF,color:#0F0F0F,stroke:#0F0F0F
    classDef bad fill:#FF5A36,color:#FFFFFF,stroke:#0F0F0F
    classDef ai fill:#F55036,color:#FFFFFF,stroke:#0F0F0F
    class O,C,E,R ink
    class G ai
    class V,P white
    class HU,AG,VF lime
    class X bad
    class RS lime
```

### 🗃️ Data model (MongoDB)

```mermaid
erDiagram
    USER ||--o{ NETWORK : owns
    USER ||--o{ SESSION : has
    NETWORK ||--o{ MEMBERSHIP : contains
    DEVICE ||--o{ MEMBERSHIP : "holds address via"
    DEVICE ||--o{ ENROLLMENT_TOKEN : "enrolled with"
    DEVICE ||--o{ HEARTBEAT : sends
    DEVICE ||--o{ MEASUREMENT : reports
    DEVICE ||--o{ PEER_OBSERVATION : observes
    DEVICE ||--o{ INCIDENT : affected_by
    INCIDENT ||--o{ DIAGNOSTIC_RUN : investigated_by
    INCIDENT ||--o{ PROPOSED_ACTION : proposes
    PROPOSED_ACTION ||--o| APPROVAL : "decided by"
    PROPOSED_ACTION ||--o| AGENT_COMMAND : "executes as"

    NETWORK {
        string cidr "unique-overlap checked"
        int configVersion
    }
    MEMBERSHIP {
        string address "unique per network"
        string status
    }
    DEVICE {
        string identityFingerprint "unique"
        string wireguardPublicKey "unique"
        date lastHeartbeatAt "server clock"
    }
    MEASUREMENT {
        string type
        float value "null if unavailable"
        bool valid
        date expiresAt "TTL 7 days"
    }
```

Integrity rules live in the database as unique / partial / TTL indexes — see [docs/database-schema.md](docs/database-schema.md).

## 🚀 Quick start

**Prerequisites:** Node 20+, Python 3.11+ (only for AI diagnostics). MongoDB is optional — `npm run dev:mongo`
starts a local one, or point `MONGODB_URI` at Docker / Atlas. Go is only needed to rebuild the agent.

```bash
# 1 · control plane  (terminal A + B)
cd control-plane
cp .env.example .env
npm install
npm run dev:mongo          # A: dev-only MongoDB on 127.0.0.1:27017
npm run dev                # B: http://localhost:4000

# 2 · console  (terminal C)
cd frontend
cp .env.example .env.local
npm install
npm run dev                # http://localhost:3000 → sign up (first account becomes admin)
```

Then **register a pc** in the console and, in an **Administrator** PowerShell:

```powershell
cd networking-agent\bin
.\nexlink-agent.exe enroll --server http://localhost:4000   # paste the token
.\nexlink-agent.exe run
```

<details>
<summary>🐹 Build the agent yourself</summary>

```bash
cd networking-agent
go build -o bin/nexlink-agent.exe ./cmd/nexlink-agent
```
</details>

<details>
<summary>🤖 Enable "ask ai" with Groq</summary>

```powershell
cd diagnostic-service
python -m venv .venv; .venv\Scripts\pip install -r requirements.txt
$env:NEXLINK_DIAG_PROVIDER="groq"; $env:GROQ_API_KEY="<your key>"
.venv\Scripts\python -m uvicorn app.api.main:app --host 127.0.0.1 --port 8090
```
Set `DIAGNOSTIC_SERVICE_URL=http://127.0.0.1:8090` in `control-plane/.env`. Only evidence summaries are sent to Groq.
</details>

<details>
<summary>🔗 Connect two PCs over WireGuard</summary>

Step-by-step, including Windows firewall commands: **[docs/two-pc-test.md](docs/two-pc-test.md)**.
`nexlink-agent export-config` writes the tunnel file for the WireGuard app; `nexlink-agent doctor` tells you exactly what is missing.
</details>

## 🧪 Testing

| Suite | Command | Result | Category |
|---|---|:---:|---|
| 🧭 Control plane | `cd control-plane && npm test` | ✅ 57 / 57 | integration vs ephemeral MongoDB + simulated agent with real keys |
| 🐹 Go agent | `cd networking-agent && go test ./...` | ✅ 18 / 18 | unit (loopback only, no host changes) |
| 🐹 Agent ↔ control plane | `go test -tags integration ./tests/` | ✅ passed | real agent vs running control plane |
| 🤖 Diagnostic service | `cd diagnostic-service && python -m pytest -q` | ✅ 15 / 15 | contract tests, Groq mocked |
| 🔗 Two-PC WireGuard | [docs/two-pc-test.md](docs/two-pc-test.md) | ⏳ pending | separate physical machines |

## 🛡️ Security model

- 🍪 Sessions in **HttpOnly, SameSite=Strict** cookies; CSRF token kept in memory only; scrypt password hashing; lockout + rate limits.
- 🪪 Devices prove identity with **Ed25519** — every agent request is signed and replay-protected; device id comes from the signature, not the body.
- 🔑 Private keys **never leave the device** and are never stored in the database.
- 🛡️ RBAC enforced in the backend; out-of-scope resources return 404.
- 🧱 Agent is **read-only by default**; host changes need `NEXLINK_ENABLE_PRIVILEGED=true` locally *and* an approved command.
- 🤖 AI output is untrusted input: strict schema, evidence grounding, action allowlist, policy engine, human approval, agent-side allowlist.

Full analysis: [docs/threat-model.md](docs/threat-model.md).

## 📁 Repository layout

```text
nexlink/
├── 🖥️ frontend/            Next.js console (JavaScript, Tailwind, React Flow, Socket.IO)
├── 🧭 control-plane/       Express + MongoDB: auth, networks, enrollment, telemetry, incidents, policy, audit
├── 🐹 networking-agent/    Go agent: identity, signed transport, WireGuard, probes, executor, doctor
├── 🤖 diagnostic-service/  FastAPI: diagnostic contracts, mock + Groq providers, grounding validator
├── 📚 docs/                architecture, threat model, protocols, API, schema, roadmap, two-PC runbook
└── 🐳 docker-compose.yml   MongoDB (+ optional control plane / diagnostic service)
```

## 📚 Documentation

| Doc | What's inside |
|---|---|
| [architecture.md](docs/architecture.md) | components, health model, diagnostic loop, MongoDB constraints |
| [network-protocols.md](docs/network-protocols.md) | enrollment, request signing, telemetry v1, probes, NAT/relay design |
| [api-contracts.md](docs/api-contracts.md) | every REST endpoint with permissions |
| [database-schema.md](docs/database-schema.md) | collections, indexes, retention |
| [threat-model.md](docs/threat-model.md) | threats, mitigations, known gaps |
| [two-pc-test.md](docs/two-pc-test.md) | runbook for the first real tunnel |
| [implementation-roadmap.md](docs/implementation-roadmap.md) | stage status and test categories |

## 🗺️ Roadmap

- [x] Secure control plane, MongoDB, auth, RBAC, audit
- [x] Enrollment, signed agent protocol, telemetry, honest health model
- [x] Deterministic incidents, policy engine, approvals, verification
- [x] Go agent built and integration-tested
- [x] Groq provider behind guardrails
- [ ] 🔗 First real two-PC WireGuard tunnel ([runbook](docs/two-pc-test.md))
- [ ] 🤖 Live Groq diagnosis review with a real key
- [ ] 🛰️ Relay fallback + NAT traversal for PCs behind different routers
- [ ] 🔒 TLS deployment guide, OS keychain key storage, MFA

<div align="center">
<sub>Built with 🟢 electric lime · #C7FF2E</sub>
</div>
#   n e x l i n k k  
 