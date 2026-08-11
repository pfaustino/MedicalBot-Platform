import {
  METRIC_TYPES,
  conditionDisplayLabel,
  storedModuleConfigSchema,
  type StoredModuleConfig,
} from '@medbot/shared'
import { complete, OpenRouterError } from './openrouter.js'

const METRIC_LIST = METRIC_TYPES.join(', ')

const SYSTEM = `You design a patient self-tracking module for one diagnosis in a personal health app.

Rules:
- Pick ONLY metric types from this allowlist: ${METRIC_LIST}
- Choose 1–5 metrics that are clinically relevant to THIS diagnosis specifically (not generic mood/symptom fillers unless they truly fit).
- Include brief target ranges when they are standard patient-facing bands; otherwise use null.
- dailyPrompts: 0–2 (0 = log when the user chooses; 1 = daily nudge).
- summary: one short sentence naming what is tracked for this condition.
- targetRationale: one short sentence explaining why these metrics fit this diagnosis (shown to the patient before they confirm).
- promptGuidance: short instructions for an assistant helping the patient log — do not diagnose, prescribe, or change meds.
- redFlags / trends: optional; only include when thresholds are clear and patient-safe.
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
  "trends": [ { "id": string, "description": string, "detect": string } ],
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

/**
 * Ask OpenRouter for a condition-specific StoredModuleConfig.
 * Strict Zod validation — invalid or off-allowlist metrics are rejected.
 */
export async function generateModuleConfig(
  input: GenerateModuleConfigInput,
): Promise<GeneratedModuleProposal> {
  const label = conditionDisplayLabel({
    key: input.key,
    displayName: input.displayName,
  })
  const icd = input.icdCode?.trim() || null

  const user = [
    `Diagnosis display name: ${label}`,
    `Stored key: ${input.key}`,
    icd ? `ICD code: ${icd}` : 'ICD code: (none)',
    '',
    'Propose tracking metrics that fit this diagnosis.',
  ].join('\n')

  const result = await complete({
    task: 'analyze',
    userId: input.userId,
    temperature: 0.2,
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

  const { targetRationale: _drop, ...rest } = obj
  const parsed = storedModuleConfigSchema.safeParse({
    ...rest,
    label,
  })
  if (!parsed.success) {
    throw new Error('Model returned a module config that failed validation')
  }

  return {
    config: parsed.data,
    targetRationale,
    source: 'ai',
  }
}

export { OpenRouterError }
