import { z } from 'zod'

/**
 * Every observation the platform records lands in one shape. Questionnaire scores
 * use it too, so a PHQ-9 trend charts on the same axis as blood glucose.
 */
export const METRIC_TYPES = [
  'blood_glucose',
  'weight',
  'blood_pressure',
  'heart_rate',
  'a1c',
  'temperature',
  'spo2',
  'sleep_hours',
  'sleep_quality',
  'mood',
  'anxiety',
  'pain',
  'steps',
  'water_intake',
  'symptom_severity',
  'side_effect_severity',
  'questionnaire_score',
  'lab_value',
] as const
export type MetricType = (typeof METRIC_TYPES)[number]

/** Meal/time context. Blood glucose is meaningless without it. */
export const GLUCOSE_CONTEXTS = [
  'fasting',
  'pre_meal',
  'post_meal',
  'bedtime',
  'random',
  'hypo_event',
] as const
export type GlucoseContext = (typeof GLUCOSE_CONTEXTS)[number]

/**
 * Curated episode keys stored as metrics.context on type `symptom_severity`.
 * Keep this list stable so Metrics can chart one episode type at a time.
 */
export const EPISODE_TYPES = [
  'dizziness',
  'fall',
  'blackout',
  'vomiting',
  'diarrhea',
  'nausea',
  'chest_pain',
  'palpitations',
  'shortness_of_breath',
  'headache',
  'confusion',
  'weakness',
  'other',
] as const
export type EpisodeType = (typeof EPISODE_TYPES)[number]

export const EPISODE_LABELS: Record<EpisodeType, string> = {
  dizziness: 'Dizziness',
  fall: 'Fall',
  blackout: 'Blackout / syncope',
  vomiting: 'Vomiting',
  diarrhea: 'Diarrhea',
  nausea: 'Nausea',
  chest_pain: 'Chest pain',
  palpitations: 'Palpitations',
  shortness_of_breath: 'Shortness of breath',
  headache: 'Headache',
  confusion: 'Confusion',
  weakness: 'Weakness',
  other: 'Other episode',
}

export const METRIC_SOURCES = [
  'manual',
  'chat_extraction',
  'device_import',
  'lab_upload',
  'questionnaire',
] as const
export type MetricSource = (typeof METRIC_SOURCES)[number]

/**
 * Canonical unit per metric type. Values are stored in these units; the UI may
 * display converted values but the database never holds mixed units.
 */
export const CANONICAL_UNITS: Record<MetricType, string> = {
  blood_glucose: 'mg/dL',
  weight: 'kg',
  blood_pressure: 'mmHg',
  heart_rate: 'bpm',
  a1c: '%',
  temperature: 'C',
  spo2: '%',
  sleep_hours: 'h',
  sleep_quality: 'score_1_10',
  mood: 'score_1_10',
  anxiety: 'score_1_10',
  pain: 'score_0_10',
  steps: 'count',
  water_intake: 'mL',
  symptom_severity: 'score_0_10',
  side_effect_severity: 'score_0_10',
  questionnaire_score: 'points',
  lab_value: 'varies',
}

export const metricEntrySchema = z.object({
  type: z.enum(METRIC_TYPES),
  /** Primary numeric value. For blood_pressure this is systolic. */
  value: z.number(),
  /** Secondary value — only blood_pressure uses it (diastolic). */
  valueSecondary: z.number().nullable().default(null),
  unit: z.string().min(1),
  recordedAt: z.coerce.date(),
  source: z.enum(METRIC_SOURCES).default('manual'),
  /** Free-form qualifier: glucose context, symptom name, lab name, med name. */
  context: z.string().max(120).nullable().default(null),
  note: z.string().max(2000).nullable().default(null),
})
export type MetricEntry = z.infer<typeof metricEntrySchema>

export const metricEntryInputSchema = metricEntrySchema.partial({
  unit: true,
  recordedAt: true,
})
export type MetricEntryInput = z.input<typeof metricEntryInputSchema>

/** Fills in the canonical unit and timestamp when the caller omitted them. */
export function normalizeMetricInput(
  input: MetricEntryInput,
  now: Date = new Date(),
): MetricEntry {
  const parsed = metricEntryInputSchema.parse(input)
  return metricEntrySchema.parse({
    ...parsed,
    unit: parsed.unit ?? CANONICAL_UNITS[parsed.type],
    recordedAt: parsed.recordedAt ?? now,
  })
}
