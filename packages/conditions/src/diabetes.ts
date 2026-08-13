import type { ConditionModule } from './types.js'

/**
 * Type 2 diabetes. Data-dense: frequent numeric readings with meal context, and
 * the interesting signal is usually a pattern across days rather than any one
 * reading. Thresholds follow common ADA targets and are defaults only — a
 * user's endocrinologist may set different ones, and per-user overrides win.
 */
export const diabetesT2: ConditionModule = {
  key: 'diabetes_t2',
  label: 'Type 2 Diabetes',
  summary:
    'Tracks blood glucose with meal context, weight, and A1C. Watches for hypo/hyper events and post-meal spikes.',
  metrics: [
    {
      type: 'blood_glucose',
      dailyPrompts: 2,
      targetMin: 80,
      targetMax: 180,
      contexts: ['fasting', 'pre_meal', 'post_meal', 'bedtime'],
    },
    { type: 'weight', dailyPrompts: 0, targetMin: null, targetMax: null },
    { type: 'a1c', dailyPrompts: 0, targetMin: null, targetMax: 7 },
    { type: 'blood_pressure', dailyPrompts: 0, targetMin: null, targetMax: 130 },
  ],
  questionnaireKeys: ['diabetes_distress', 'med_adherence'],
  redFlags: [
    {
      id: 'severe_hypo',
      metric: 'blood_glucose',
      operator: 'lt',
      threshold: 54,
      occurrences: 1,
      windowHours: 1,
      severity: 'emergency',
      message:
        'Blood sugar below 54 mg/dL is severe hypoglycemia. Treat with 15g fast sugar now and re-check in 15 minutes.',
    },
    {
      id: 'hypo',
      metric: 'blood_glucose',
      operator: 'lt',
      threshold: 70,
      occurrences: 1,
      windowHours: 1,
      severity: 'urgent',
      message: 'Blood sugar below 70 mg/dL. Treat with 15g of fast-acting carbs and re-check in 15 minutes.',
    },
    {
      id: 'recurrent_hypo',
      metric: 'blood_glucose',
      operator: 'lt',
      threshold: 70,
      occurrences: 3,
      windowHours: 168,
      severity: 'notice',
      message:
        'Three or more lows this week. This is worth raising with your prescriber — it can mean a medication adjustment is needed.',
    },
    {
      id: 'severe_hyper',
      metric: 'blood_glucose',
      operator: 'gt',
      threshold: 400,
      occurrences: 1,
      windowHours: 1,
      severity: 'emergency',
      message:
        'Blood sugar above 400 mg/dL. Check ketones if you can and contact your doctor now — this can progress to DKA.',
    },
    {
      id: 'sustained_hyper',
      metric: 'blood_glucose',
      operator: 'gt',
      threshold: 250,
      occurrences: 4,
      windowHours: 72,
      severity: 'urgent',
      message: 'Blood sugar has been over 250 repeatedly for several days. Contact your care team.',
    },
  ],
  trends: [
    {
      id: 'dawn_phenomenon',
      description: 'Fasting readings climbing overnight',
      detect: 'Fasting glucose trending upward over 7+ days while daytime readings stay flat.',
      eval: {
        metric: 'blood_glucose',
        context: 'fasting',
        kind: 'avg_vs_prior',
        windowDays: 7,
        priorDays: 7,
        threshold: 15,
        direction: 'up',
      },
    },
    {
      id: 'postprandial_spikes',
      description: 'Large post-meal excursions',
      detect: 'Post-meal readings exceeding pre-meal by more than 80 mg/dL on most days.',
    },
    {
      id: 'adherence_glucose_link',
      description: 'Missed doses tracking with high readings',
      detect: 'Days with skipped or missed medication doses showing higher average glucose than adherent days.',
    },
  ],
  promptGuidance: `The user has type 2 diabetes. When they report a glucose reading, always \
capture meal context — a 180 fasting and a 180 two hours after eating mean very different \
things. Never suggest an insulin dose or a change to any diabetes medication. You may point \
out patterns in their own data and help them prepare questions for their endocrinologist.`,
}

/**
 * Type 1 diabetes. Same core metrics as T2 (glucose with meal context, A1C, weight,
 * BP) but the guidance assumes insulin dependence — still never dose-advise.
 */
export const diabetesT1: ConditionModule = {
  key: 'diabetes_t1',
  label: 'Type 1 Diabetes',
  summary:
    'Tracks blood glucose with meal context, weight, and A1C. Watches for hypo/hyper events; assumes insulin therapy without suggesting doses.',
  metrics: diabetesT2.metrics,
  questionnaireKeys: ['diabetes_distress', 'med_adherence'],
  redFlags: diabetesT2.redFlags,
  trends: [
    ...diabetesT2.trends,
    {
      id: 'insulin_timing',
      description: 'Timing gaps around insulin and meals',
      detect:
        'Post-meal spikes or lows that cluster when meal context and logged insulin timing are far apart (user-reported only).',
    },
  ],
  promptGuidance: `The user has type 1 diabetes and uses insulin. When they report a glucose \
reading, always capture meal context. Never suggest an insulin dose, correction factor, or \
carb ratio change — those come only from their care team. You may point out patterns in \
their own data and help them prepare questions for their endocrinologist.`,
}
