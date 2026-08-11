'use client'

import { useState } from 'react'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Loaded } from '../components/Loader'
import { ConditionPicker, type ConditionSelection } from '../components/ConditionPicker'
import { apiPost, apiDelete } from '@/lib/api'
import { METRIC_LABELS, formatDate, titleCase } from '@/lib/format'
import { getConditionReference } from '@medbot/shared'
import type { ConditionKey } from '@medbot/shared'

interface TrackedMetric {
  type: string
  dailyPrompts: number
  targetMin: number | null
  targetMax: number | null
}

interface Threshold {
  id: string
  metric: string
  operator: 'lt' | 'gt'
  threshold: number
  occurrences: number
  windowHours: number
  severity: string
  message: string
}

interface Condition {
  id: string
  key: string
  label: string
  summary: string | null
  status: string
  diagnosedAt: string | null
  notes: string | null
  hasModule: boolean
  trackedMetrics: TrackedMetric[]
  thresholds: Threshold[]
  trends: Array<{ id: string; description: string; detect: string }>
}

function describeThreshold(t: Threshold): string {
  const dir = t.operator === 'lt' ? 'below' : 'above'
  const label = METRIC_LABELS[t.metric] ?? t.metric
  if (t.occurrences <= 1) return `${label} ${dir} ${t.threshold}`
  const window =
    t.windowHours >= 168
      ? `${Math.round(t.windowHours / 168)} week(s)`
      : `${Math.round(t.windowHours / 24)} day(s)`
  return `${label} ${dir} ${t.threshold}, ${t.occurrences}× within ${window}`
}

/** Patient-education panel, shown when the glossary has a reference for this key. */
function ConditionEducation({ conditionKey }: { conditionKey: string }) {
  const ref = getConditionReference(conditionKey as ConditionKey)
  if (!ref) return null

  return (
    <details className="stack">
      <summary>Learn about this condition</summary>
      <p className="hint">General patient education — background to help you prepare questions, not medical advice.</p>

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

function ConditionCard({ c, onChanged }: { c: Condition; onChanged: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

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

  async function addModule() {
    if (busy) return
    setBusy(true)
    try {
      await apiPost(`/api/conditions/${encodeURIComponent(c.key)}/module`)
      toast.show(`Tracking enabled for ${c.label}.`, 'ok')
      onChanged()
    } catch {
      toast.show('Could not add a module for that condition.', 'err')
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{c.label}</h2>
          <p className="hint">
            {titleCase(c.status)}
            {c.diagnosedAt && ` · diagnosed ${formatDate(c.diagnosedAt)}`}
          </p>
        </div>
        {!c.hasModule && (
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={addModule}>
            {busy ? 'Adding…' : 'Add Module'}
          </button>
        )}
      </div>

      {c.summary && <p>{c.summary}</p>}
      {c.notes && <p className="hint">{c.notes}</p>}

      {!c.hasModule ? (
        <p className="hint">
          Recorded on your profile, but nothing tracks it automatically yet. Add a module to
          start logging symptoms and related metrics for this condition.
        </p>
      ) : (
        <>
          <h3>Tracked metrics</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Target</th>
                  <th>Prompts / day</th>
                </tr>
              </thead>
              <tbody>
                {c.trackedMetrics.map((m) => (
                  <tr key={m.type}>
                    <td>{METRIC_LABELS[m.type] ?? m.type}</td>
                    <td>
                      {m.targetMin === null && m.targetMax === null
                        ? '—'
                        : `${m.targetMin ?? ''}${m.targetMin !== null && m.targetMax !== null ? '–' : ''}${m.targetMax ?? ''}`}
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
                    <span className="hint">{t.detect}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <ConditionEducation conditionKey={c.key} />

      <div className="btn-row">
        <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={remove}>
          Remove
        </button>
      </div>
    </div>
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
            Search tracked conditions, ICD-10 codes, or add any diagnosis in your own words.
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
