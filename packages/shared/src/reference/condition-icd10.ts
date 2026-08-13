import type { ConditionKey } from '../profile.js'

/** Canonical ICD-10-CM code + NIH name for each built-in condition key. */
export const CONDITION_ICD10: Record<ConditionKey, { code: string; name: string }> = {
  diabetes_t1: { code: 'E10.9', name: 'Type 1 diabetes mellitus without complications' },
  diabetes_t2: { code: 'E11.9', name: 'Type 2 diabetes mellitus without complications' },
  prediabetes: { code: 'R73.03', name: 'Prediabetes' },
  schizophrenia: { code: 'F20.9', name: 'Schizophrenia, unspecified' },
  schizoaffective: { code: 'F25.9', name: 'Schizoaffective disorder, unspecified' },
  bipolar: { code: 'F31.9', name: 'Bipolar disorder, unspecified' },
  depression: { code: 'F32.9', name: 'Major depressive disorder, single episode, unspecified' },
  anxiety: { code: 'F41.9', name: 'Anxiety disorder, unspecified' },
  hypertension: { code: 'I10', name: 'Essential (primary) hypertension' },
  hyperlipidemia: { code: 'E78.5', name: 'Hyperlipidemia, unspecified' },
  ckd: { code: 'N18.9', name: 'Chronic kidney disease, unspecified' },
  copd: { code: 'J44.9', name: 'Chronic obstructive pulmonary disease, unspecified' },
  asthma: { code: 'J45.909', name: 'Unspecified asthma, uncomplicated' },
  thyroid: { code: 'E07.9', name: 'Disorder of thyroid, unspecified' },
  epilepsy: { code: 'G40.909', name: 'Epilepsy, unspecified' },
  chronic_pain: { code: 'G89.29', name: 'Other chronic pain' },
  obesity: { code: 'E66.9', name: 'Obesity, unspecified' },
}
