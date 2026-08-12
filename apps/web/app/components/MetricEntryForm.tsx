'use client'

import { useState } from 'react'
import { EPISODE_LABELS, EPISODE_TYPES, type EpisodeType } from '@medbot/shared'
import { apiPost } from '@/lib/api'
import { useToast } from './Toast'
import { METRIC_UNITS } from '@/lib/format'

interface Alert {
  id: string
  severity: string
  message: string
}

/** Metric types offered in the manual logger, in a sensible order. */
const LOGGABLE: Array<{ type: string; label: string }> = [
  { type: 'blood_glucose', label: 'Blood glucose' },
  { type: 'blood_pressure', label: 'Blood pressure' },
  { type: 'weight', label: 'Weight' },
  { type: 'heart_rate', label: 'Heart rate' },
  { type: 'sleep_hours', label: 'Sleep' },
  { type: 'mood', label: 'Mood' },
  { type: 'anxiety', label: 'Anxiety' },
  { type: 'pain', label: 'Pain' },
  { type: 'temperature', label: 'Temperature' },
  { type: 'spo2', label: 'Oxygen saturation' },
  { type: 'steps', label: 'Steps' },
  { type: 'water_intake', label: 'Water' },
  { type: 'a1c', label: 'A1C' },
  { type: 'side_effect_severity', label: 'Side effect severity' },
]

const GLUCOSE_CONTEXTS = [
  { value: 'fasting', label: 'Fasting' },
  { value: 'pre_meal', label: 'Before a meal' },
  { value: 'post_meal', label: 'After a meal' },
  { value: 'bedtime', label: 'Bedtime' },
  { value: 'random', label: 'Random' },
  { value: 'hypo_event', label: 'Low event' },
]

const SEVERITY_PRESETS = [
  { value: 3, label: 'Mild' },
  { value: 6, label: 'Moderate' },
  { value: 9, label: 'Severe' },
]

function localNow(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

export function MetricEntryForm({
  defaultType = 'blood_glucose',
  defaultMode = 'reading',
  defaultEpisode = 'dizziness',
  onDone,
}: {
  defaultType?: string
  defaultMode?: 'reading' | 'episode'
  defaultEpisode?: string
  onDone?: () => void
}) {
  const toast = useToast()
  const [mode, setMode] = useState<'reading' | 'episode'>(defaultMode)
  const [type, setType] = useState(defaultType === 'symptom_severity' ? 'blood_glucose' : defaultType)
  const [episode, setEpisode] = useState<EpisodeType>(
    EPISODE_TYPES.includes(defaultEpisode as EpisodeType)
      ? (defaultEpisode as EpisodeType)
      : 'dizziness',
  )
  const [value, setValue] = useState('')
  const [severity, setSeverity] = useState('6')
  const [secondary, setSecondary] = useState('')
  const [context, setContext] = useState('fasting')
  const [note, setNote] = useState('')
  const [recordedAt, setRecordedAt] = useState(localNow())
  const [busy, setBusy] = useState(false)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [error, setError] = useState<string | null>(null)

  const isBp = type === 'blood_pressure'
  const isGlucose = type === 'blood_glucose'
  const unit = METRIC_UNITS[type] ?? ''

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setAlerts([])

    if (mode === 'episode') {
      const sev = Number(severity)
      if (severity === '' || Number.isNaN(sev) || sev < 0 || sev > 10) {
        setError('Severity must be a number from 0 to 10.')
        return
      }
      setBusy(true)
      try {
        const res = await apiPost<{ id: string; alerts: Alert[] }>('/api/metrics', {
          type: 'symptom_severity',
          value: sev,
          context: episode,
          recordedAt: new Date(recordedAt).toISOString(),
          note: note || null,
        })
        if (res.alerts?.length) {
          setAlerts(res.alerts)
          toast.show('Logged — see the alert below.', 'info')
        } else {
          toast.show('Episode logged.', 'ok')
        }
        setNote('')
        onDone?.()
      } catch {
        setError('Could not save that episode. Please try again.')
      } finally {
        setBusy(false)
      }
      return
    }

    const num = Number(value)
    if (!value || Number.isNaN(num)) {
      setError('Enter a numeric value.')
      return
    }
    if (isBp && (!secondary || Number.isNaN(Number(secondary)))) {
      setError('Blood pressure needs both systolic and diastolic.')
      return
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        type,
        value: num,
        recordedAt: new Date(recordedAt).toISOString(),
        note: note || null,
      }
      if (isBp) body.valueSecondary = Number(secondary)
      if (isGlucose) body.context = context
      const res = await apiPost<{ id: string; alerts: Alert[] }>('/api/metrics', body)
      if (res.alerts?.length) {
        setAlerts(res.alerts)
        toast.show('Logged — see the alert below.', 'info')
      } else {
        toast.show('Reading logged.', 'ok')
      }
      setValue('')
      setSecondary('')
      setNote('')
      onDone?.()
    } catch {
      setError('Could not save that reading. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="log-mode-toggle btn-row" role="group" aria-label="What to log">
        <button
          type="button"
          className={mode === 'reading' ? 'chip chip-active' : 'chip'}
          onClick={() => setMode('reading')}
        >
          Reading
        </button>
        <button
          type="button"
          className={mode === 'episode' ? 'chip chip-active' : 'chip'}
          onClick={() => setMode('episode')}
        >
          Episode
        </button>
      </div>

      {mode === 'reading' ? (
        <div className="form-grid">
          <label className="field">
            <span>Metric</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {LOGGABLE.map((m) => (
                <option key={m.type} value={m.type}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>
              {isBp ? 'Systolic' : 'Value'}
              {unit ? ` (${unit})` : ''}
            </span>
            <input
              type="number"
              step="any"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isBp ? '120' : ''}
              autoFocus
            />
          </label>

          {isBp && (
            <label className="field">
              <span>Diastolic (mmHg)</span>
              <input
                type="number"
                step="any"
                value={secondary}
                onChange={(e) => setSecondary(e.target.value)}
                placeholder="80"
              />
            </label>
          )}

          {isGlucose && (
            <label className="field">
              <span>Context</span>
              <select value={context} onChange={(e) => setContext(e.target.value)}>
                {GLUCOSE_CONTEXTS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>When</span>
            <input
              type="datetime-local"
              value={recordedAt}
              onChange={(e) => setRecordedAt(e.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className="form-grid">
          <label className="field">
            <span>Episode</span>
            <select
              value={episode}
              onChange={(e) => setEpisode(e.target.value as EpisodeType)}
              autoFocus
            >
              {EPISODE_TYPES.map((key) => (
                <option key={key} value={key}>
                  {EPISODE_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Severity (0–10)</span>
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            />
            <span className="help-text">How bad was it at its peak?</span>
          </label>

          <div className="field">
            <span>Quick set</span>
            <div className="btn-row">
              {SEVERITY_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={Number(severity) === p.value ? 'chip chip-active' : 'chip'}
                  onClick={() => setSeverity(String(p.value))}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span>When</span>
            <input
              type="datetime-local"
              value={recordedAt}
              onChange={(e) => setRecordedAt(e.target.value)}
            />
          </label>
        </div>
      )}

      <label className="field">
        <span>Note (optional)</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            mode === 'episode'
              ? 'What was happening — after a dose, standing up, meal…'
              : 'Anything worth remembering about this reading'
          }
        />
      </label>

      {error && <p className="field-error">{error}</p>}

      {alerts.map((a) => (
        <div
          key={a.id}
          className={`alert alert-${a.severity === 'emergency' ? 'emergency' : a.severity === 'urgent' ? 'urgent' : 'notice'}`}
        >
          <strong>{a.severity === 'emergency' ? 'Urgent — ' : ''}</strong>
          {a.message}
        </div>
      ))}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : mode === 'episode' ? 'Log episode' : 'Log reading'}
        </button>
      </div>
    </form>
  )
}
