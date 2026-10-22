'use strict';

/**
 * Built-in AI provider: Groq's OpenAI-compatible chat completions, called
 * from this process. Same prompt and contract as diagnostic-service/app/
 * providers/groq.py, so a deployment needs no second service.
 *
 * The model's answer is untrusted: callers validate it against the result
 * schema and the evidence-grounding rules before anything is stored or shown,
 * and any proposed action still goes through the policy engine.
 *
 * Privacy: only evidence ref/kind/summary/timestamp are sent — never raw
 * `data` payloads, keys, tokens or passwords. The API key is never logged.
 */

const SYSTEM_PROMPT = `You are the diagnostic planner for NexLink, a WireGuard private-network platform.
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
`;

class ProviderError extends Error {}

/** request: the same body the HTTP diagnostic service receives. */
async function planWithGroq({ config, request, signal }) {
  const model = config.GROQ_MODEL;
  const user = {
    incident: request.incident,
    evidence: request.evidence.slice(0, 80).map((e) => ({ ref: e.ref, kind: e.kind, summary: e.summary, observed_at: e.observed_at ?? null })),
    allowed_actions: request.allowed_actions,
  };
  const payload = {
    model,
    temperature: 0.1,
    // Reasoning models spend tokens thinking before the JSON answer.
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(user) },
    ],
    ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
  };

  let res;
  try {
    res = await fetch(`${config.GROQ_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`groq request failed: ${err.name}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = String((await res.json())?.error?.message || '').slice(0, 200);
    } catch {
      /* non-JSON error body */
    }
    throw new ProviderError(`groq HTTP ${res.status}: ${detail.split(config.GROQ_API_KEY).join('[REDACTED]')}`);
  }
  let out;
  try {
    out = JSON.parse((await res.json()).choices[0].message.content);
  } catch {
    throw new ProviderError('groq returned a non-JSON or malformed completion');
  }
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new ProviderError('groq completion is not a JSON object');
  return { result: out, provider: `groq:${model}` };
}

module.exports = { planWithGroq, ProviderError, SYSTEM_PROMPT };
