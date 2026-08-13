import type { MetricType } from '@medbot/shared'

/**
 * A condition module is the platform's extensibility seam. It declares what a
 * given diagnosis means operationally: what to track, how often to ask, and
 * what counts as concerning. Built-in modules live as TypeScript files here;
 * custom diagnoses can store the same shape as JSON on the conditions row.
 */

export interface TrackedMetric {
  type: MetricType
  /** Times per day the user is nudged. 0 = track opportunistically, never nudge. */
  dailyPrompts: number
  /** Inclusive target band. Personalized per user later; these are defaults. */
  targetMin: number | null
  targetMax: number | null
  /** Meal contexts to ask for, when the metric is context-sensitive. */
  contexts?: readonly string[]
}

export interface RedFlag {
  id: string
  metric: MetricType
  /** For lab_value (and similar), limit this flag to one analyte. */
  context?: string
  /** Fires when a reading is outside this band. */
  operator: 'lt' | 'gt'
  threshold: number
  /** How many readings in the window before it escalates. 1 = immediate. */
  occurrences: number
  windowHours: number
  severity: 'notice' | 'urgent' | 'emergency'
  message: string
}

export interface TrendEval {
  metric: MetricType
  /** Lab analyte or glucose meal context when the metric is shared. */
  context?: string
  kind: 'avg_vs_prior' | 'rise_in_window' | 'avg_above' | 'latest_vs_earliest'
  windowDays: number
  /** For avg_vs_prior: length of the comparison window. Defaults to windowDays. */
  priorDays?: number
  threshold: number
  /** latest_vs_earliest / rise_in_window / avg_vs_prior. */
  direction?: 'up' | 'down'
}

export interface TrendRule {
  id: string
  description: string
  /** Human-readable so the analysis model can reason over it. */
  detect: string
  /** When set, the API can mark this pattern firing from recorded metrics. */
  eval?: TrendEval
}

export interface ConditionModule {
  /** Built-in ConditionKey, or the user's condition row key for dynamic modules. */
  key: string
  label: string
  /** Short line the AI layer gets in its context when the user has this. */
  summary: string
  metrics: readonly TrackedMetric[]
  questionnaireKeys: readonly string[]
  redFlags: readonly RedFlag[]
  trends: readonly TrendRule[]
  /** Extra guardrails appended to the system prompt for this condition. */
  promptGuidance: string
}
