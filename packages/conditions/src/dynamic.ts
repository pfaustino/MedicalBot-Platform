import {
  conditionDisplayLabel,
  inferModuleKey,
  type ConditionKey,
  type MetricType,
  type StoredModuleConfig,
} from '@medbot/shared'
import { getModule } from './registry.js'
import type { ConditionModule, TrackedMetric } from './types.js'

type MetricDefaults = Omit<TrackedMetric, 'contexts'> & { contexts?: string[] }

function metric(
  type: MetricType,
  dailyPrompts: number,
  targetMin: number | null,
  targetMax: number | null,
  contexts?: string[],
): MetricDefaults {
  return contexts
    ? { type, dailyPrompts, targetMin, targetMax, contexts }
    : { type, dailyPrompts, targetMin, targetMax }
}

function mentalHealthDefaults(label: string): StoredModuleConfig {
  return {
    summary: `Tracks daily mood, anxiety, and sleep for ${label}.`,
    metrics: [
      metric('mood', 1, 4, 10),
      metric('anxiety', 1, 0, 4),
      metric('sleep_hours', 0, 6, 10),
      metric('sleep_quality', 0, 5, 10),
    ],
    questionnaireKeys: [],
    redFlags: [],
    trends: [
      {
        id: 'rising_distress',
        description: 'Mood or anxiety trending worse',
        detect: 'Average mood dropping or anxiety rising over 7 days vs the prior 7 days.',
      },
    ],
    promptGuidance: `The user is tracking ${label}. Help them log mood, anxiety, and sleep. Do not diagnose, reinterpret feelings, or suggest medication changes. Help prepare questions for their clinician from their own data.`,
  }
}

function bloodPressureDefaults(label: string): StoredModuleConfig {
  return {
    summary: `Tracks blood pressure and heart rate for ${label}.`,
    metrics: [
      metric('blood_pressure', 1, 90, 130),
      metric('heart_rate', 0, 50, 100),
      metric('weight', 0, null, null),
    ],
    questionnaireKeys: [],
    redFlags: [
      {
        id: 'hypertensive_crisis',
        metric: 'blood_pressure',
        operator: 'gt',
        threshold: 180,
        occurrences: 1,
        windowHours: 24,
        severity: 'urgent',
        message: 'Systolic reading above 180 — contact your care team or urgent care.',
      },
    ],
    trends: [
      {
        id: 'bp_climbing',
        description: 'Blood pressure averaging higher',
        detect: '7-day average systolic higher than the prior 7 days by 10+ mmHg.',
      },
    ],
    promptGuidance: `The user is tracking ${label}. Help them log blood pressure (systolic/diastolic) and related vitals. Do not adjust medications. Escalate urgent readings by reminding them of the app thresholds and to contact their clinician.`,
  }
}

function metabolicDefaults(label: string): StoredModuleConfig {
  return {
    summary: `Tracks weight and activity for ${label}.`,
    metrics: [
      metric('weight', 0, null, null),
      metric('steps', 0, null, null),
      metric('blood_glucose', 0, 70, 180, ['fasting', 'random']),
    ],
    questionnaireKeys: [],
    redFlags: [],
    trends: [
      {
        id: 'weight_trend',
        description: 'Weight changing over weeks',
        detect: 'Weight moving steadily up or down across 2+ weeks of readings.',
      },
    ],
    promptGuidance: `The user is tracking ${label}. Help them log weight, steps, and any glucose readings they share. Do not prescribe diets or medication changes.`,
  }
}

function painDefaults(label: string): StoredModuleConfig {
  return {
    summary: `Tracks pain and mood for ${label}.`,
    metrics: [
      metric('pain', 1, 0, 3),
      metric('mood', 1, 4, 10),
      metric('sleep_hours', 0, 6, 10),
    ],
    questionnaireKeys: [],
    redFlags: [],
    trends: [
      {
        id: 'pain_climbing',
        description: 'Pain scores climbing',
        detect: 'Average pain over 7 days higher than the prior 7 days by 2+ points.',
      },
    ],
    promptGuidance: `The user is tracking ${label}. Help them log pain severity and related mood/sleep. Do not recommend starting or changing pain medication.`,
  }
}

function respiratoryDefaults(label: string): StoredModuleConfig {
  return {
    summary: `Tracks breathing-related symptom severity for ${label}.`,
    metrics: [
      metric('symptom_severity', 1, 0, 3),
      metric('spo2', 0, 92, 100),
      metric('mood', 0, 4, 10),
    ],
    questionnaireKeys: [],
    redFlags: [
      {
        id: 'low_spo2',
        metric: 'spo2',
        operator: 'lt',
        threshold: 90,
        occurrences: 1,
        windowHours: 24,
        severity: 'urgent',
        message: 'Oxygen saturation under 90% — seek urgent medical care.',
      },
    ],
    trends: [
      {
        id: 'respiratory_worsening',
        description: 'Breathing symptoms worsening',
        detect: 'Symptom severity rising over several days, or SpO2 trending down.',
      },
    ],
    promptGuidance: `The user is tracking ${label}. Help them log symptom severity and SpO2 when available. For severe shortness of breath or very low SpO2, urge contacting emergency services or their care team — do not triage as a clinician.`,
  }
}

/**
 * Condition-specific templates for known enum keys that lack a code module.
 * Never used as a catch-all for unmatched diagnoses (e.g. anosmia).
 */
const TEMPLATES_BY_KEY: Partial<Record<ConditionKey, (label: string) => StoredModuleConfig>> = {
  depression: mentalHealthDefaults,
  bipolar: mentalHealthDefaults,
  hypertension: bloodPressureDefaults,
  hyperlipidemia: metabolicDefaults,
  prediabetes: metabolicDefaults,
  obesity: metabolicDefaults,
  chronic_pain: painDefaults,
  asthma: respiratoryDefaults,
  copd: respiratoryDefaults,
}

/**
 * Look up a condition-specific template when the row maps to a known key that
 * has no code module. Returns null when no honest template exists — callers
 * must generate via AI or refuse, never invent unrelated tracking.
 */
export function lookupTemplateModuleConfig(input: {
  key: string
  displayName?: string | null
  icdCode?: string | null
  label?: string
}): StoredModuleConfig | null {
  const label =
    input.label?.trim() ||
    conditionDisplayLabel({ key: input.key, displayName: input.displayName })
  const inferred =
    inferModuleKey({
      key: input.key,
      displayName: input.displayName,
      icdCode: input.icdCode,
    }) ?? null
  const template = inferred ? TEMPLATES_BY_KEY[inferred] : undefined
  return template ? template(label) : null
}

/** @deprecated Prefer lookupTemplateModuleConfig — no generic catch-all. */
export function buildDefaultModuleConfig(input: {
  key: string
  displayName?: string | null
  icdCode?: string | null
  label?: string
}): StoredModuleConfig {
  const found = lookupTemplateModuleConfig(input)
  if (!found) {
    throw new Error(
      'No condition-specific template for this diagnosis. Generate via AI or refuse.',
    )
  }
  return found
}

export function moduleFromConfig(
  rowKey: string,
  config: StoredModuleConfig,
  fallbackLabel: string,
): ConditionModule {
  return {
    key: rowKey,
    label: config.label?.trim() || fallbackLabel,
    summary: config.summary,
    metrics: config.metrics,
    questionnaireKeys: config.questionnaireKeys ?? [],
    redFlags: config.redFlags ?? [],
    trends: config.trends ?? [],
    promptGuidance: config.promptGuidance ?? '',
  }
}

export interface ConditionModuleRow {
  key: string
  displayName?: string | null
  icdCode?: string | null
  moduleConfig?: StoredModuleConfig | null
}

/**
 * Resolve operational modules for user condition rows.
 * Code modules win when present; otherwise a stored dynamic config is used.
 */
export function resolveModulesForConditions(
  rows: readonly ConditionModuleRow[],
): ConditionModule[] {
  const out: ConditionModule[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const inferred = inferModuleKey({
      key: row.key,
      displayName: row.displayName,
      icdCode: row.icdCode,
    })
    const code = inferred ? getModule(inferred) : null
    if (code) {
      if (!seen.has(code.key)) {
        seen.add(code.key)
        out.push(code)
      }
      continue
    }
    if (row.moduleConfig) {
      const label = conditionDisplayLabel({
        key: row.key,
        displayName: row.displayName,
      })
      const mod = moduleFromConfig(row.key, row.moduleConfig, label)
      if (!seen.has(mod.key)) {
        seen.add(mod.key)
        out.push(mod)
      }
    }
  }

  return out
}

/** Resolve a single row for Conditions UI enrichment. */
export function resolveModuleForCondition(
  row: ConditionModuleRow,
): ConditionModule | null {
  return resolveModulesForConditions([row])[0] ?? null
}
