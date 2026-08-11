import type { ConditionKey } from '@medbot/shared'
import type { ConditionModule } from './types.js'
import { anxiety } from './anxiety.js'
import { ckd } from './ckd.js'
import { diabetesT1, diabetesT2 } from './diabetes.js'
import { schizophrenia } from './schizophrenia.js'

export const CONDITION_MODULES: Partial<Record<ConditionKey, ConditionModule>> = {
  anxiety,
  ckd,
  diabetes_t1: diabetesT1,
  diabetes_t2: diabetesT2,
  schizophrenia,
  // schizoaffective shares the schizophrenia module until it earns its own.
  schizoaffective: { ...schizophrenia, key: 'schizoaffective', label: 'Schizoaffective Disorder' },
}

export function getModule(key: ConditionKey): ConditionModule | null {
  return CONDITION_MODULES[key] ?? null
}
