export const METRIC_LABELS: Record<string, string> = {
  blood_glucose: 'Blood glucose',
  weight: 'Weight',
  blood_pressure: 'Blood pressure',
  heart_rate: 'Heart rate',
  a1c: 'A1C',
  temperature: 'Temperature',
  spo2: 'Oxygen saturation',
  sleep_hours: 'Sleep',
  sleep_quality: 'Sleep quality',
  mood: 'Mood',
  anxiety: 'Anxiety',
  pain: 'Pain',
  steps: 'Steps',
  water_intake: 'Water',
  symptom_severity: 'Symptom severity',
  side_effect_severity: 'Side effects',
  questionnaire_score: 'Assessment score',
  lab_value: 'Lab value',
}

export const CONTEXT_LABELS: Record<string, string> = {
  fasting: 'Fasting',
  pre_meal: 'Before a meal',
  post_meal: 'After a meal',
  bedtime: 'Bedtime',
  random: 'Random',
  hypo_event: 'Low event',
  sedation: 'Sedation',
  restlessness: 'Restlessness',
  stiffness: 'Stiffness',
  tremor: 'Tremor',
  weight_gain: 'Weight gain',
  dry_mouth: 'Dry mouth',
  phq9: 'PHQ-9',
  gad7: 'GAD-7',
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

/** Blood pressure is the only metric that renders two numbers. */
export function formatMetric(
  type: string,
  value: number | null,
  secondary: number | null = null,
): string {
  if (value === null) return '—'
  if (type === 'blood_pressure' && secondary !== null) return `${value}/${secondary}`
  return String(value)
}

/**
 * PG `date` columns (dateOfBirth, diagnosedAt, startedAt, …) arrive either as
 * `YYYY-MM-DD` or as a midnight-UTC ISO timestamp. Both represent a calendar
 * day, not a moment — format them pinned to UTC so local time can't roll the
 * day back.
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?(?:Z|\+00:?00))?$/

function parseDateValue(value: string | Date): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00Z`)
  }
  return new Date(value)
}

export function formatDate(value: string | Date): string {
  const isDateOnly = typeof value === 'string' && DATE_ONLY_RE.test(value)
  return parseDateValue(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(isDateOnly ? { timeZone: 'UTC' } : {}),
  })
}

export function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function titleCase(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export const ROLE_LABELS: Record<string, string> = {
  primary_care: 'Primary care',
  endocrinologist: 'Endocrinologist',
  psychiatrist: 'Psychiatrist',
  therapist: 'Therapist',
  cardiologist: 'Cardiologist',
  nephrologist: 'Nephrologist',
  neurologist: 'Neurologist',
  pharmacist: 'Pharmacist',
  case_manager: 'Case manager',
  other: 'Other',
}

export const APPT_TYPE_LABELS: Record<string, string> = {
  office_visit: 'Office visit',
  lab: 'Lab',
  imaging: 'Imaging',
  therapy: 'Therapy',
  injection: 'Injection',
  procedure: 'Procedure',
  other: 'Other',
}

export const MED_FORM_LABELS: Record<string, string> = {
  tablet: 'Tablet',
  capsule: 'Capsule',
  liquid: 'Liquid',
  injection: 'Injection',
  inhaler: 'Inhaler',
  patch: 'Patch',
  topical: 'Topical',
  other: 'Other',
}

export const ADHERENCE_LABELS: Record<string, string> = {
  taken: 'Taken',
  late: 'Late',
  skipped: 'Skipped',
  missed: 'Missed',
}

/** Canonical unit per metric type, for showing next to entry fields. */
export const METRIC_UNITS: Record<string, string> = {
  blood_glucose: 'mg/dL',
  weight: 'kg',
  blood_pressure: 'mmHg',
  heart_rate: 'bpm',
  a1c: '%',
  temperature: '°C',
  spo2: '%',
  sleep_hours: 'h',
  sleep_quality: '1–10',
  mood: '1–10',
  anxiety: '1–10',
  pain: '0–10',
  steps: 'steps',
  water_intake: 'mL',
  symptom_severity: '0–10',
  side_effect_severity: '0–10',
  questionnaire_score: 'points',
  lab_value: '',
}

/** Round-trips a stored ISO date into the value an <input type="date"> wants. */
export function toDateInput(value: string | Date | null): string {
  if (!value) return ''
  // Date-only values keep their calendar day regardless of local timezone.
  if (typeof value === 'string' && DATE_ONLY_RE.test(value)) return value.slice(0, 10)
  const d = new Date(value)
  if (Number.isNaN(+d)) return ''
  return d.toISOString().slice(0, 10)
}
