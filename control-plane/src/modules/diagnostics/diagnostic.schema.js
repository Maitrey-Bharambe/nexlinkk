'use strict';

const { z } = require('zod');

/**
 * Structured diagnostic result. Deterministic rules and any future LLM
 * provider must produce exactly this shape. Note there is no "confidence"
 * field: uncalibrated model scores are not accepted.
 */
const diagnosticResultSchema = z
  .object({
    incident_id: z.string(),
    summary: z.string().min(1).max(1000),
    observations: z
      .array(z.object({ statement: z.string().min(1).max(500), evidence_refs: z.array(z.string()).min(1).max(20) }).strict())
      .max(30),
    hypotheses: z
      .array(
        z
          .object({
            statement: z.string().min(1).max(500),
            status: z.enum(['plausible', 'ruled_out', 'untested']),
            supporting_refs: z.array(z.string()).max(20),
          })
          .strict(),
      )
      .max(15),
    evidence: z.array(z.string()).max(100),
    uncertainties: z.array(z.string().min(1).max(500)).max(20),
    proposed_actions: z
      .array(
        z
          .object({
            action_type: z.string().max(64),
            params: z.record(z.string(), z.unknown()).default({}),
            rationale: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(5),
    requires_human_approval: z.literal(true),
  })
  .strict();

/**
 * Schema check plus grounding check: every cited ref must exist in the
 * evidence the tools actually collected. A planner cannot invent evidence.
 */
function validateDiagnosticResult(raw, { incidentId, evidenceRefs }) {
  const parsed = diagnosticResultSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const r = parsed.data;
  const errors = [];
  const known = new Set(evidenceRefs);
  if (r.incident_id !== incidentId) errors.push('incident_id does not match the incident under investigation');
  r.observations.forEach((o, i) =>
    o.evidence_refs.forEach((ref) => !known.has(ref) && errors.push(`observations[${i}] cites unknown evidence "${ref}"`)),
  );
  r.hypotheses.forEach((h, i) =>
    h.supporting_refs.forEach((ref) => !known.has(ref) && errors.push(`hypotheses[${i}] cites unknown evidence "${ref}"`)),
  );
  r.evidence.forEach((ref) => !known.has(ref) && errors.push(`evidence lists unknown ref "${ref}"`));
  return errors.length ? { ok: false, errors } : { ok: true, value: r };
}

module.exports = { diagnosticResultSchema, validateDiagnosticResult };
