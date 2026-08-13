'use client'

import { useEffect, useState } from 'react'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Loaded } from '../components/Loader'
import { ConditionPicker, type ConditionSelection } from '../components/ConditionPicker'
import { apiGet, apiPost, apiPatch, apiDelete, ApiError, apiErrorMessage } from '@/lib/api'
import { METRIC_LABELS, formatDate, formatMetric, titleCase } from '@/lib/format'
import { getConditionReference, icdCodeFromConditionKey } from '@medbot/shared'
import type { ConditionKey } from '@medbot/shared'

interface RecordedMetric {
  count: number
  latestValue: number | null
  latestSecondary: number | null
  latestAt: string | null
  count7d: number
  average7d: number | null
  inRange7d: number | null
}

interface TrackedMetric {
  type: string
  dailyPrompts: number
  targetMin: number | null
  targetMax: number | null
  contexts?: string[]
  recorded?: RecordedMetric
}

interface Threshold {
  id: string
  metric: string
  context?: string
  operator: 'lt' | 'gt'
  threshold: number
  occurrences: number
  windowHours: number
  severity: string
  message: string
}

interface ModuleConfigPreview {
  summary: string
  metrics: TrackedMetric[]
  label?: string
  promptGuidance?: string
  questionnaireKeys?: string[]
  redFlags?: Threshold[]
  trends?: Array<{ id: string; description: string; detect: string }>
}

interface ModulePreviewResponse {
  ok: true
  preview: true
  source: 'template' | 'ai'
  label: string
  config: ModuleConfigPreview
  targetRationale: string
  metricTypes: string[]
}

interface Condition {
  id: string
  key: string
  label: string
  summary: string | null
  status: string
  icdCode: string | null
  diagnosedAt: string | null
  notes: string | null
  hasModule: boolean
  isDynamicModule?: boolean
  trackedMetrics: TrackedMetric[]
  thresholds: Threshold[]
  trends: Array<{
    id: string
    description: string
    detect: string
    status?: 'firing' | 'watching' | 'insufficient'
    detail?: string | null
  }>
}

function describeThreshold(t: Threshold): string {
  const dir = t.operator === 'lt' ? 'below' : 'above'
  const label = t.context || METRIC_LABELS[t.metric] || t.metric
  if (t.occurrences <= 1) return `${label} ${dir} ${t.threshold}`
  const window =
    t.windowHours >= 168
      ? `${Math.round(t.windowHours / 168)} week(s)`
      : `${Math.round(t.windowHours / 24)} day(s)`
  return `${label} ${dir} ${t.threshold}, ${t.occurrences}× within ${window}`
}

function trackedMetricLabel(m: TrackedMetric): string {
  if (m.type === 'lab_value' && m.contexts?.[0]) return m.contexts[0]
  return METRIC_LABELS[m.type] ?? m.type
}

function trackedMetricHref(m: TrackedMetric): string {
  if (m.type === 'lab_value' && m.contexts?.[0]) {
    return `/metrics?type=${encodeURIComponent(`lab:${m.contexts[0]}`)}`
  }
  return `/metrics?type=${encodeURIComponent(m.type)}`
}

function metricListLabel(types: string[]): string {
  return types.map((t) => METRIC_LABELS[t] ?? t).join(', ')
}

function limitKind(m: TrackedMetric): 'floor' | 'ceiling' | 'band' | null {
  if (m.targetMin !== null && m.targetMax !== null) return 'band'
  if (m.targetMin !== null) return 'floor'
  if (m.targetMax !== null) return 'ceiling'
  return null
}

function formatLimit(m: TrackedMetric): string {
  const kind = limitKind(m)
  if (kind === 'floor') return `Don't go below ${m.targetMin}`
  if (kind === 'ceiling') return `Keep below ${m.targetMax}`
  if (kind === 'band') return `${m.targetMin}–${m.targetMax}`
  return '—'
}

function latestVsTarget(m: TrackedMetric): 'in' | 'low' | 'high' | null {
  const value = m.recorded?.latestValue
  if (value === null || value === undefined) return null
  if (m.targetMin === null && m.targetMax === null) return null
  if (m.targetMin !== null && value < m.targetMin) return 'low'
  if (m.targetMax !== null && value > m.targetMax) return 'high'
  return 'in'
}

function LatestReading({ metric }: { metric: TrackedMetric }) {
  const rec = metric.recorded
  if (!rec || rec.latestValue === null) {
    return <span className="hint">No readings</span>
  }
  const vs = latestVsTarget(metric)
  const kind = limitKind(metric)
  return (
    <>
      {formatMetric(metric.type, rec.latestValue, rec.latestSecondary)}
      {rec.latestAt && <span className="hint"> · {formatDate(rec.latestAt)}</span>}
      {kind === 'floor' && vs === 'low' && (
        <>
          {' '}
          <span className="badge badge-warn">Below {metric.targetMin}</span>
        </>
      )}
      {kind === 'ceiling' && vs === 'in' && (
        <>
          {' '}
          <span className="badge badge-ok">Under {metric.targetMax}</span>
        </>
      )}
      {kind === 'ceiling' && vs === 'high' && (
        <>
          {' '}
          <span className="badge badge-warn">Over {metric.targetMax}</span>
        </>
      )}
      {kind === 'band' && vs === 'in' && (
        <>
          {' '}
          <span className="badge badge-ok">In range</span>
        </>
      )}
      {kind === 'band' && vs === 'low' && (
        <>
          {' '}
          <span className="badge badge-warn">Below range</span>
        </>
      )}
      {kind === 'band' && vs === 'high' && (
        <>
          {' '}
          <span className="badge badge-warn">Above range</span>
        </>
      )}
    </>
  )
}

function WeekReading({ metric }: { metric: TrackedMetric }) {
  const rec = metric.recorded
  if (!rec || rec.count7d === 0) {
    return <span className="hint">None this week</span>
  }
  const expected = metric.dailyPrompts > 0 ? 7 * metric.dailyPrompts : null
  const coverage =
    expected !== null ? `${rec.count7d} of ${expected} expected` : `${rec.count7d} reading${rec.count7d === 1 ? '' : 's'}`
  return (
    <>
      {coverage}
      {rec.average7d !== null && <span className="hint"> · avg {rec.average7d}</span>}
      {rec.inRange7d !== null && (metric.targetMin !== null || metric.targetMax !== null) && (
        <>
          {' '}
          <span className={`badge ${rec.inRange7d >= 0.7 ? 'badge-ok' : 'badge-warn'}`}>
            {Math.round(rec.inRange7d * 100)}% in range
          </span>
        </>
      )}
    </>
  )
}

interface MedlinePlusReference {
  found: boolean
  topics: Array<{ title: string; url: string; summary: string }>
}

/** Patient-education panel: local glossary when we have one, otherwise MedlinePlus. */
function ConditionEducation({ conditionKey, icdCode }: { conditionKey: string; icdCode: string | null }) {
  const ref = getConditionReference(conditionKey as ConditionKey)
  if (ref) {
    return (
      <details className="stack">
        <summary>Learn about this condition</summary>
        <p className="hint">
          General patient education — background to help you prepare questions, not medical advice.
        </p>

        <h3>What it means</h3>
        <p>{ref.whatItMeans}</p>

        <h3>Common symptoms</h3>
        <ul className="plain-list">
          {ref.commonSymptoms.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>

        <h3>Why tracking matters</h3>
        <p>{ref.whyTrackingMatters}</p>

        <h3>Questions for your doctor</h3>
        <ul className="plain-list">
          {ref.questionsForYourDoctor.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>

        {ref.learnMore.length > 0 && (
          <>
            <h3>Learn more</h3>
            <ul className="plain-list">
              {ref.learnMore.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noreferrer">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="hint">{ref.disclaimer}</p>
      </details>
    )
  }

  const code = icdCode?.trim() || icdCodeFromConditionKey(conditionKey)
  if (!code) return null
  return <MedlinePlusEducation code={code} />
}

function MedlinePlusEducation({ code }: { code: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<MedlinePlusReference | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open || data || failed) return
    let live = true
    setLoading(true)
    apiGet<MedlinePlusReference>(`/api/conditions/reference?code=${encodeURIComponent(code)}`)
      .then((res) => {
        if (live) setData(res)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [open, code, data, failed])

  const primary = data?.topics[0]
  const related = data?.topics.slice(1) ?? []

  return (
    <details
      className="stack"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Learn about this condition</summary>
      {loading && <p className="hint">Looking up MedlinePlus…</p>}
      {failed && <p className="hint">Could not load a MedlinePlus reference right now.</p>}
      {data && !data.found && (
        <p className="hint">MedlinePlus does not have a page for {code} yet.</p>
      )}
      {primary && (
        <>
          <p className="hint">
            General patient education from MedlinePlus.gov — not medical advice for your situation.
          </p>
          <h3>{primary.title}</h3>
          {primary.summary && <p>{primary.summary}</p>}
          <p>
            <a href={primary.url} target="_blank" rel="noreferrer">
              Read on MedlinePlus
            </a>
          </p>
          {related.length > 0 && (
            <>
              <h3>Related</h3>
              <ul className="plain-list">
                {related.map((t) => (
                  <li key={t.url}>
                    <a href={t.url} target="_blank" rel="noreferrer">
                      {t.title}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="hint">
            Information from MedlinePlus, U.S. National Library of Medicine. This does not imply
            MedlinePlus endorsement of this app.
          </p>
        </>
      )}
    </details>
  )
}

function ConditionCard({ c, onChanged }: { c: Condition; onChanged: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<ModulePreviewResponse | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function remove() {
    if (busy) return
    if (!window.confirm(`Remove ${c.label}? This stops tracking it and removes it from your profile.`)) return
    setBusy(true)
    try {
      await apiDelete(`/api/conditions/${encodeURIComponent(c.key)}`)
      toast.show(`${c.label} removed.`, 'ok')
      onChanged()
    } catch {
      toast.show('Could not remove that condition.', 'err')
      setBusy(false)
    }
  }

  async function clearModule() {
    if (busy) return
    if (
      !window.confirm(
        `Clear tracking for ${c.label}? The condition stays on your profile; you can Add Module again later.`,
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await apiDelete(`/api/conditions/${encodeURIComponent(c.key)}/module`)
      toast.show(`Tracking cleared for ${c.label}.`, 'ok')
      onChanged()
    } catch (e) {
      const msg =
        e instanceof ApiError ? apiErrorMessage(e.body) : null
      toast.show(msg ?? 'Could not clear that module.', 'err')
      setBusy(false)
    }
  }

  async function startAddModule() {
    if (busy) return
    setBusy(true)
    try {
      const res = await apiPost<ModulePreviewResponse>(
        `/api/conditions/${encodeURIComponent(c.key)}/module`,
        { action: 'preview' },
      )
      setPreview(res)
      setBusy(false)
    } catch (e) {
      const msg = e instanceof ApiError ? apiErrorMessage(e.body) : null
      toast.show(msg ?? 'Could not propose a module for that condition.', 'err')
      setBusy(false)
    }
  }

  async function confirmModule() {
    if (!preview || confirming) return
    setConfirming(true)
    try {
      await apiPost(`/api/conditions/${encodeURIComponent(c.key)}/module`, {
        action: 'confirm',
        config: preview.config,
        targetRationale: preview.targetRationale,
      })
      setPreview(null)
      toast.show(`Tracking enabled for ${c.label}.`, 'ok')
      onChanged()
    } catch (e) {
      const msg = e instanceof ApiError ? apiErrorMessage(e.body) : null
      toast.show(msg ?? 'Could not save that module.', 'err')
      setConfirming(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{c.label}</h2>
          <p className="hint">
            {titleCase(c.status)}
            {c.icdCode && ` · ${c.icdCode}`}
            {c.diagnosedAt && ` · diagnosed ${formatDate(c.diagnosedAt)}`}
          </p>
        </div>
        {!c.hasModule && (
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={startAddModule}>
            {busy ? 'Proposing…' : 'Add Module'}
          </button>
        )}
      </div>

      {c.summary && <p>{c.summary}</p>}
      {c.notes && <p className="hint">{c.notes}</p>}

      {!c.hasModule ? (
        <p className="hint">
          Recorded on your profile, but nothing tracks it automatically yet. Add a module to
          propose condition-specific metrics (requires OpenRouter for uncommon diagnoses).
        </p>
      ) : (
        <>
          <h3>Tracked vs recorded</h3>
          <p className="hint">
            What this module asks for, next to readings you have actually logged. The same reading
            can count for more than one condition.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Limits</th>
                  <th>Latest</th>
                  <th>Last 7 days</th>
                  <th>Prompts / day</th>
                </tr>
              </thead>
              <tbody>
                {c.trackedMetrics.map((m) => (
                  <tr key={`${m.type}:${m.contexts?.[0] ?? ''}`}>
                    <td>
                      <a href={trackedMetricHref(m)}>{trackedMetricLabel(m)}</a>
                    </td>
                    <td>{formatLimit(m)}</td>
                    <td>
                      <LatestReading metric={m} />
                    </td>
                    <td>
                      <WeekReading metric={m} />
                    </td>
                    <td>{m.dailyPrompts === 0 ? 'When you log it' : m.dailyPrompts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {c.thresholds.length > 0 && (
            <>
              <h3>Thresholds</h3>
              <ul className="plain-list">
                {c.thresholds.map((t) => (
                  <li key={t.id}>
                    <strong>{describeThreshold(t)}</strong>
                    <span className="hint">{t.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {c.trends.length > 0 && (
            <>
              <h3>Patterns worth watching</h3>
              <ul className="plain-list">
                {c.trends.map((t) => (
                  <li key={t.id}>
                    <strong>{t.description}</strong>
                    {t.status === 'firing' && <span className="badge badge-warn">Active now</span>}
                    {t.status === 'insufficient' && <span className="badge">Need more readings</span>}
                    <span className="hint">{t.detail || t.detect}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <ConditionEducation conditionKey={c.key} icdCode={c.icdCode} />

      <div className="btn-row">
        <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        {c.isDynamicModule && (
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={clearModule}>
            Clear module
          </button>
        )}
        <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={remove}>
          Remove
        </button>
      </div>

      <Modal open={editing} title="Edit condition" onClose={() => setEditing(false)} wide>
        {editing && (
          <EditConditionForm
            condition={c}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false)
              onChanged()
            }}
          />
        )}
      </Modal>

      <Modal
        open={Boolean(preview)}
        title="Confirm tracking module"
        onClose={() => {
          if (!confirming) setPreview(null)
        }}
      >
        {preview && (
          <div className="stack">
            <p>
              We&apos;ll track{' '}
              <strong>{metricListLabel(preview.metricTypes)}</strong> for {preview.label}.
            </p>
            <p className="hint">{preview.targetRationale}</p>
            {preview.config.summary && <p>{preview.config.summary}</p>}
            <div className="form-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={confirming}
                onClick={() => setPreview(null)}
              >
                Cancel
              </button>
              <button type="button" className="btn-primary" disabled={confirming} onClick={confirmModule}>
                {confirming ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

function EditConditionForm({
  condition,
  onCancel,
  onSaved,
}: {
  condition: Condition
  onCancel: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const [selection, setSelection] = useState<ConditionSelection>({
    name: condition.label,
    moduleKey: null,
    icdCode: condition.icdCode,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const name = selection.name.trim()
    if (name.length < 2) {
      setError('Search for a condition or type a name (at least 2 characters).')
      return
    }
    setBusy(true)
    try {
      await apiPatch(`/api/conditions/${encodeURIComponent(condition.key)}`, {
        name,
        moduleKey: selection.moduleKey,
        icdCode: selection.icdCode,
      })
      toast.show('Condition updated.')
      onSaved()
    } catch (err) {
      const detail = err instanceof ApiError ? apiErrorMessage(err.body) : null
      setError(detail ?? 'Could not update that condition.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <label className="field">
        <span>Condition</span>
        <ConditionPicker value={selection} onChange={setSelection} error={error} autoFocus />
        <p className="help-text">
          Search the NIH catalog and pick a diagnosis to set the ICD-10-CM code. You can also type a
          name and we&apos;ll match a code when possible.
        </p>
        {selection.icdCode && <p className="help-text">ICD-10-CM {selection.icdCode}</p>}
      </label>
      {error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function ConditionForm({ onDone }: { onDone: () => void }) {
  const [selection, setSelection] = useState<ConditionSelection | null>(null)
  const [diagnosedAt, setDiagnosedAt] = useState('')
  const [status, setStatus] = useState('active')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const name = selection?.name.trim() ?? ''
    if (name.length < 2) {
      setError('Search for a condition or type a name (at least 2 characters).')
      return
    }

    const body: Record<string, unknown> = {
      name,
      status,
      moduleKey: selection?.moduleKey ?? null,
      icdCode: selection?.icdCode ?? null,
    }
    if (diagnosedAt) body.diagnosedAt = diagnosedAt
    if (notes.trim()) body.notes = notes.trim()

    setBusy(true)
    try {
      await apiPost('/api/conditions', body)
      onDone()
    } catch {
      setError('Could not add that condition. It may already be on your profile.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span>Condition</span>
          <ConditionPicker
            value={selection}
            onChange={setSelection}
            error={error}
            autoFocus
          />
          <p className="help-text">
            Search the NIH ICD-10-CM catalog (~75,000 diagnoses), tracked conditions, or add any
            diagnosis in your own words.
          </p>
        </label>
        <label className="field">
          <span>Diagnosed (optional)</span>
          <input type="date" value={diagnosedAt} onChange={(e) => setDiagnosedAt(e.target.value)} />
        </label>
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="remission">Remission</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
      </div>

      <label className="field">
        <span>Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything you want to remember about this diagnosis"
          rows={3}
        />
      </label>

      {error && <p className="field-error">{error}</p>}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add condition'}
        </button>
      </div>
    </form>
  )
}

export default function ConditionsPage() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const refetch = () => setReloadKey((k) => k + 1)

  return (
    <AppGate>
      <main>
        <div className="page-header">
          <h1>Conditions</h1>
          <div className="page-actions">
            <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
              + Add condition
            </button>
          </div>
        </div>

        <p className="muted">
          Each condition loads a module that decides what gets tracked and what the target
          ranges are. Where two conditions track the same metric, the stricter band wins.
        </p>

        <Loaded<{ conditions: Condition[] }> key={reloadKey} path="/api/conditions">
          {(d) =>
            d.conditions.length === 0 ? (
              <div className="card">No conditions recorded yet.</div>
            ) : (
              <div className="stack">
                {d.conditions.map((c) => (
                  <ConditionCard key={c.id} c={c} onChanged={refetch} />
                ))}
              </div>
            )
          }
        </Loaded>

        <Modal open={open} title="Add condition" onClose={() => setOpen(false)} wide>
          <ConditionForm
            onDone={() => {
              setOpen(false)
              refetch()
              toast.show('Condition added.', 'ok')
            }}
          />
        </Modal>
      </main>
    </AppGate>
  )
}
