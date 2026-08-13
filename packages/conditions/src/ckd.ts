import type { ConditionModule } from './types.js'

/**
 * Chronic kidney disease — oriented toward Stage IV (eGFR typically 15–29).
 *
 * The key signal is lab trend (eGFR / creatinine as `lab_value` with context),
 * plus blood pressure and weight, which nephrology visits care about. Thresholds
 * are defaults only; the user's nephrologist sets personal targets.
 */
export const ckd: ConditionModule = {
  key: 'ckd',
  label: 'Chronic Kidney Disease',
  summary:
    'Tracks eGFR and related kidney labs, blood pressure, and weight. Tuned for Stage IV monitoring (eGFR often 15–29) without diagnosing or staging.',
  metrics: [
    {
      type: 'lab_value',
      dailyPrompts: 0,
      targetMin: 15,
      targetMax: null,
      contexts: ['eGFR'],
    },
    { type: 'blood_pressure', dailyPrompts: 1, targetMin: null, targetMax: 130 },
    { type: 'weight', dailyPrompts: 0, targetMin: null, targetMax: null },
  ],
  questionnaireKeys: ['med_adherence'],
  redFlags: [
    {
      id: 'egfr_critical',
      metric: 'lab_value',
      context: 'eGFR',
      operator: 'lt',
      threshold: 15,
      occurrences: 1,
      windowHours: 168,
      severity: 'urgent',
      message:
        'eGFR under 15 is in the range often associated with Stage V kidney disease. Contact your nephrology team — do not wait for a routine visit.',
    },
    {
      id: 'severe_hypertension',
      metric: 'blood_pressure',
      operator: 'gt',
      threshold: 180,
      occurrences: 1,
      windowHours: 24,
      severity: 'urgent',
      message:
        'Systolic blood pressure over 180. Recheck, rest, and contact your care team — severe hypertension is especially concerning with CKD.',
    },
    {
      id: 'sustained_high_bp',
      metric: 'blood_pressure',
      operator: 'gt',
      threshold: 140,
      occurrences: 4,
      windowHours: 168,
      severity: 'notice',
      message:
        'Blood pressure has been over 140 several times this week. Kidney protection often depends on BP control — worth raising with your nephrologist.',
    },
  ],
  trends: [
    {
      id: 'egfr_decline',
      description: 'eGFR trending down',
      detect: 'Serial eGFR readings declining over 3+ months, especially approaching or crossing 15.',
    },
    {
      id: 'weight_fluid',
      description: 'Rapid weight gain suggesting fluid retention',
      detect: 'Weight up more than 2 kg over a few days without a clear diet explanation.',
    },
    {
      id: 'bp_control',
      description: 'Home BP vs clinic targets',
      detect: 'Home systolic averages above the user-stated or clinic target across a week.',
    },
  ],
  promptGuidance: `The user has chronic kidney disease (often Stage IV). When they report a lab, \
capture the test name in context (eGFR, creatinine, potassium, etc.) — a bare number is not \
useful. Never suggest changing ACE inhibitors, ARBs, diuretics, or other kidney-related meds. \
You may help them organize lab trends and questions for their nephrologist.`,
}
