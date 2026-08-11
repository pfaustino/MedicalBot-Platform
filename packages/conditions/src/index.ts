import type { ConditionKey, MetricType } from '@medbot/shared'
import type { ConditionModule, RedFlag, TrackedMetric } from './types.js'
import { CONDITION_MODULES, getModule } from './registry.js'

export * from './types.js'
export {
  buildDefaultModuleConfig,
  moduleFromConfig,
  resolveModuleForCondition,
  resolveModulesForConditions,
} from './dynamic.js'
export type { ConditionModuleRow } from './dynamic.js'
export { anxiety } from './anxiety.js'
export { ckd } from './ckd.js'
export { diabetesT1, diabetesT2 } from './diabetes.js'
export { schizophrenia } from './schizophrenia.js'
export { CONDITION_MODULES, getModule }

export function modulesFor(keys: readonly ConditionKey[]): ConditionModule[] {
  return keys.map(getModule).filter((m): m is ConditionModule => m !== null)
}

/**
 * Union of metrics across a user's conditions. When two modules track the same
 * metric, the stricter target and the higher prompt frequency win — a user with
 * both diabetes and schizophrenia should get the tighter glucose band.
 */
export function mergedMetrics(modules: readonly ConditionModule[]): TrackedMetric[] {
  const byType = new Map<MetricType, TrackedMetric>()

  for (const mod of modules) {
    for (const metric of mod.metrics) {
      const existing = byType.get(metric.type)
      if (!existing) {
        byType.set(metric.type, { ...metric })
        continue
      }
      byType.set(metric.type, {
        type: metric.type,
        dailyPrompts: Math.max(existing.dailyPrompts, metric.dailyPrompts),
        targetMin: strictest(existing.targetMin, metric.targetMin, Math.max),
        targetMax: strictest(existing.targetMax, metric.targetMax, Math.min),
        contexts: existing.contexts ?? metric.contexts,
      })
    }
  }

  return [...byType.values()]
}

function strictest(
  a: number | null,
  b: number | null,
  pick: (x: number, y: number) => number,
): number | null {
  if (a === null) return b
  if (b === null) return a
  return pick(a, b)
}

export function mergedRedFlags(modules: readonly ConditionModule[]): RedFlag[] {
  const seen = new Set<string>()
  const flags: RedFlag[] = []
  for (const mod of modules) {
    for (const flag of mod.redFlags) {
      const id = `${mod.key}:${flag.id}`
      if (seen.has(id)) continue
      seen.add(id)
      flags.push(flag)
    }
  }
  return flags
}

export function mergedQuestionnaireKeys(modules: readonly ConditionModule[]): string[] {
  return [...new Set(modules.flatMap((m) => m.questionnaireKeys))]
}
