import { labAliasForMetricType, labContextMatches } from '@medbot/shared'
import type { TrendEval, TrendRule } from './types.js'

export type TrendStatus = 'firing' | 'watching' | 'insufficient'

export interface TrendReading {
  type: string
  value: number
  recordedAt: Date
  context: string | null
}

export interface EvaluatedTrend {
  id: string
  description: string
  detect: string
  status: TrendStatus
  detail: string | null
}

function matchesEval(row: TrendReading, spec: TrendEval): boolean {
  if (spec.metric === 'a1c') {
    const alias = labAliasForMetricType('a1c')
    return (
      row.type === 'a1c' ||
      (row.type === 'lab_value' && Boolean(alias) && labContextMatches(row.context, alias!))
    )
  }
  if (row.type !== spec.metric) return false
  if (!spec.context) return true
  if (spec.metric === 'lab_value') return labContextMatches(row.context, spec.context)
  return (row.context ?? '').toLowerCase() === spec.context.toLowerCase()
}

function inWindow(rows: TrendReading[], now: Date, days: number, offsetDays = 0): TrendReading[] {
  const end = new Date(+now - offsetDays * 24 * 60 * 60 * 1000)
  const start = new Date(+end - days * 24 * 60 * 60 * 1000)
  return rows.filter((r) => +r.recordedAt >= +start && +r.recordedAt <= +end)
}

function avg(rows: TrendReading[]): number | null {
  if (rows.length === 0) return null
  return rows.reduce((s, r) => s + r.value, 0) / rows.length
}

function crossed(delta: number, spec: TrendEval): boolean {
  const dir = spec.direction ?? 'up'
  if (dir === 'down') return delta <= -spec.threshold
  return delta >= spec.threshold
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function evaluateTrend(rule: TrendRule, readings: TrendReading[], now: Date = new Date()): EvaluatedTrend {
  const base = { id: rule.id, description: rule.description, detect: rule.detect }
  const spec = rule.eval
  if (!spec) {
    return { ...base, status: 'watching', detail: null }
  }

  const matched = readings
    .filter((r) => matchesEval(r, spec))
    .sort((a, b) => +a.recordedAt - +b.recordedAt)

  if (spec.kind === 'avg_vs_prior') {
    const priorDays = spec.priorDays ?? spec.windowDays
    const recent = inWindow(matched, now, spec.windowDays, 0)
    const prior = inWindow(matched, now, priorDays, spec.windowDays)
    if (recent.length < 2 || prior.length < 2) {
      return { ...base, status: 'insufficient', detail: 'Not enough readings in both windows yet.' }
    }
    const recentAvg = avg(recent)!
    const priorAvg = avg(prior)!
    const delta = recentAvg - priorAvg
    const firing = crossed(delta, spec)
    return {
      ...base,
      status: firing ? 'firing' : 'watching',
      detail: `Last ${spec.windowDays}d avg ${fmt(recentAvg)} vs prior ${fmt(priorAvg)} (${delta >= 0 ? '+' : ''}${fmt(delta)}).`,
    }
  }

  if (spec.kind === 'avg_above') {
    const recent = inWindow(matched, now, spec.windowDays, 0)
    if (recent.length < 2) {
      return { ...base, status: 'insufficient', detail: 'Not enough readings this window.' }
    }
    const recentAvg = avg(recent)!
    const firing = recentAvg > spec.threshold
    return {
      ...base,
      status: firing ? 'firing' : 'watching',
      detail: `${spec.windowDays}-day average ${fmt(recentAvg)} (limit ${spec.threshold}).`,
    }
  }

  if (spec.kind === 'rise_in_window') {
    const recent = inWindow(matched, now, spec.windowDays, 0)
    if (recent.length < 2) {
      return { ...base, status: 'insufficient', detail: 'Need at least two readings in this window.' }
    }
    const first = recent[0]!.value
    const last = recent[recent.length - 1]!.value
    const delta = last - first
    const firing = crossed(delta, spec)
    return {
      ...base,
      status: firing ? 'firing' : 'watching',
      detail: `Changed ${delta >= 0 ? '+' : ''}${fmt(delta)} over ${spec.windowDays} days (${fmt(first)} → ${fmt(last)}).`,
    }
  }

  if (spec.kind === 'latest_vs_earliest') {
    const recent = inWindow(matched, now, spec.windowDays, 0)
    if (recent.length < 2) {
      return { ...base, status: 'insufficient', detail: 'Need at least two readings in this window.' }
    }
    const first = recent[0]!.value
    const last = recent[recent.length - 1]!.value
    const delta = last - first
    const firing = crossed(delta, spec)
    return {
      ...base,
      status: firing ? 'firing' : 'watching',
      detail: `${fmt(first)} → ${fmt(last)} over ${spec.windowDays} days (${delta >= 0 ? '+' : ''}${fmt(delta)}).`,
    }
  }

  return { ...base, status: 'watching', detail: null }
}

export function evaluateTrends(rules: readonly TrendRule[], readings: TrendReading[], now?: Date): EvaluatedTrend[] {
  return rules.map((rule) => evaluateTrend(rule, readings, now))
}
