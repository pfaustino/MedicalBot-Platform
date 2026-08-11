import {
  METRIC_TYPES,
  conditionDisplayLabel,
  storedModuleConfigSchema,
  storedRedFlagSchema,
  storedTrendRuleSchema,
  type StoredModuleConfig,
} from '@medbot/shared'
import { complete, OpenRouterError } from './openrouter.js'

const METRIC_LIST = METRIC_TYPES.join(', ')
const METRIC_SET = new Set<string>(METRIC_TYPES)

const SYSTEM = `You design a patient self-tracking module for one diagnosis in a personal health app.

Rules:
- Pick ONLY metric types from this allowlist: ${METRIC_LIST}
- Never invent metric type names. Map clinical ideas onto the closest allowlisted type (e.g. itch/rash → symptom_severity, nerve pain → pain, creatinine/eGFR → lab_value).
- Choose 1–5 metrics that are clinically relevant to THIS diagnosis specifically (not generic mood/symptom fillers unless they truly fit).
- Include brief target ranges when they are standard patient-facing bands; otherwise use null.
- dailyPrompts: integer 0–2 (0 = log when the user chooses; 1 = daily nudge).
- summary: one short sentence naming what is tracked for this condition.
- targetRationale: one short sentence explaining why these metrics fit this diagnosis (shown to the patient before they confirm).
- promptGuidance: short instructions for an assistant helping the patient log — do not diagnose, prescribe, or change meds.
- redFlags: prefer []. Only include a redFlag when every field is known (id, metric from allowlist, operator lt|gt, threshold, occurrences, windowHours, severity notice|urgent|emergency, message).
- trends: optional short list; each needs id, description, detect. Prefer [] if unsure.
- questionnaireKeys: usually [].
- Return ONLY a single JSON object, no prose and no code fences.

JSON shape:
{
  "summary": string,
  "targetRationale": string,
  "metrics": [
    { "type": "<allowlisted metric>", "dailyPrompts": number, "targetMin": number|null, "targetMax": number|null, "contexts": string[] (optional) }
  ],
  "questionnaireKeys": [],
  "redFlags": [],
  "trends": [],
  "promptGuidance": string
}`

export interface GenerateModuleConfigInput {
  userId: string
  key: string
  displayName?: string | null
  icdCode?: string | null
}

export interface GeneratedModuleProposal {
  config: StoredModuleConfig
  targetRationale: string
  source: 'ai'
}

function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  return (fenced?.[1] ?? trimmed).trim()
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  return asFiniteNumber(value)
}

function sanitizeMetric(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const type = typeof m.type === 'string' ? m.type.trim() : ''
  if (!METRIC_SET.has(type)) return null

  const daily = asFiniteNumber(m.dailyPrompts)
  const dailyPrompts = daily === null ? 0 : Math.max(0, Math.min(24, Math.round(daily)))

  const out: Record<string, unknown> = {
    type,
    dailyPrompts,
    targetMin: asNullableNumber(m.targetMin),
    targetMax: asNullableNumber(m.targetMax),
  }
  if (Array.isArray(m.contexts)) {
    const contexts = m.contexts
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c) => c.trim())
      .slice(0, 12)
    if (contexts.length) out.contexts = contexts
  }
  return out
}

function sanitizeCandidate(obj: Record<string, unknown>, label: string): Record<string, unknown> {
  const metricsRaw = Array.isArray(obj.metrics) ? obj.metrics : []
  const seen = new Set<string>()
  const metrics: Record<string, unknown>[] = []
  for (const item of metricsRaw) {
    const m = sanitizeMetric(item)
    if (!m) continue
    const type = m.type as string
    if (seen.has(type)) continue
    seen.add(type)
    metrics.push(m)
    if (metrics.length >= 5) break
  }

  const redFlags = Array.isArray(obj.redFlags)
    ? obj.redFlags
        .map((item) => storedRedFlagSchema.safeParse(item))
        .filter((r) => r.success)
        .map((r) => r.data)
        .slice(0, 10)
    : []

  const trends = Array.isArray(obj.trends)
    ? obj.trends
        .map((item) => storedTrendRuleSchema.safeParse(item))
        .filter((r) => r.success)
        .map((r) => r.data)
        .slice(0, 10)
    : []

  const questionnaireKeys = Array.isArray(obj.questionnaireKeys)
    ? obj.questionnaireKeys
        .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        .map((k) => k.trim())
        .slice(0, 20)
    : []

  const summary =
    typeof obj.summary === 'string' && obj.summary.trim()
      ? obj.summary.trim().slice(0, 1000)
      : `Tracks key readings for ${label}.`

  const promptGuidance =
    typeof obj.promptGuidance === 'string' ? obj.promptGuidance.trim().slice(0, 4000) : undefined

  return {
    label,
    summary,
    metrics,
    questionnaireKeys,
    redFlags,
    trends,
    ...(promptGuidance ? { promptGuidance } : {}),
  }
}

function formatZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

async function requestProposal(
  input: GenerateModuleConfigInput,
  label: string,
  extraUserNote?: string,
): Promise<{ raw: unknown; targetRationale: string }> {
  const icd = input.icdCode?.trim() || null
  const user = [
    `Diagnosis display name: ${label}`,
    `Stored key: ${input.key}`,
    icd ? `ICD code: ${icd}` : 'ICD code: (none)',
    '',
    'Propose tracking metrics that fit this diagnosis.',
    extraUserNote ? `\n${extraUserNote}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const result = await complete({
    task: 'analyze',
    userId: input.userId,
    temperature: 0.1,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
  })

  let raw: unknown
  try {
    raw = JSON.parse(stripFences(result.content))
  } catch {
    throw new Error('Model did not return valid JSON')
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('Model did not return a JSON object')
  }

  const obj = raw as Record<string, unknown>
  const targetRationale =
    typeof obj.targetRationale === 'string' && obj.targetRationale.trim()
      ? obj.targetRationale.trim().slice(0, 400)
      : `Suggested metrics for tracking ${label}.`

  return { raw: obj, targetRationale }
}

function tryValidate(
  obj: Record<string, unknown>,
  label: string,
):
  | { ok: true; config: StoredModuleConfig; targetRationale: string }
  | { ok: false; issues: string; targetRationale: string } {
  const targetRationale =
    typeof obj.targetRationale === 'string' && obj.targetRationale.trim()
      ? obj.targetRationale.trim().slice(0, 400)
      : `Suggested metrics for tracking ${label}.`

  const { targetRationale: _drop, ...rest } = obj
  const sanitized = sanitizeCandidate(rest, label)
  const parsed = storedModuleConfigSchema.safeParse(sanitized)
  if (!parsed.success) {
    return { ok: false, issues: formatZodIssues(parsed.error.issues), targetRationale }
  }
  return { ok: true, config: parsed.data, targetRationale }
}

/**
 * Ask OpenRouter for a condition-specific StoredModuleConfig.
 * Sanitizes allowlisted metrics / well-formed flags, then retries once if needed.
 */
export async function generateModuleConfig(
  input: GenerateModuleConfigInput,
): Promise<GeneratedModuleProposal> {
  const label = conditionDisplayLabel({
    key: input.key,
    displayName: input.displayName,
  })

  const first = await requestProposal(input, label)
  let attempt = tryValidate(first.raw as Record<string, unknown>, label)

  if (!attempt.ok) {
    const retry = await requestProposal(
      input,
      label,
      [
        'Your previous JSON failed validation. Fix it and return ONLY valid JSON.',
        `Validation issues: ${attempt.issues}`,
        `Use ONLY these metric types: ${METRIC_LIST}`,
        'Prefer empty redFlags and trends arrays. Keep 1–5 allowlisted metrics.',
      ].join('\n'),
    )
    attempt = tryValidate(retry.raw as Record<string, unknown>, label)
    if (!attempt.ok) {
      throw new Error(
        `Model returned a module config that failed validation (${attempt.issues})`,
      )
    }
    return {
      config: attempt.config,
      targetRationale: attempt.targetRationale || retry.targetRationale,
      source: 'ai',
    }
  }

  return {
    config: attempt.config,
    targetRationale: attempt.targetRationale || first.targetRationale,
    source: 'ai',
  }
}

export { OpenRouterError }
