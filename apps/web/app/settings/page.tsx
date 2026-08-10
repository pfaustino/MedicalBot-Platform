'use client'

import { useEffect, useState } from 'react'
import { apiGet, apiPatch, apiPost, apiPut, apiDelete } from '@/lib/api'
import { AppGate } from '../components/AppGate'
import { useToast } from '../components/Toast'
import { ModelPicker } from '../components/ModelPicker'
import { ThemeToggle } from '../components/ThemeToggle'
import { SAMPLE_PERSONAS } from '@medbot/shared'

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string } | { kind: 'error'; message: string }

const PERSONA_KEY = 'medbot_persona'
const DEFAULT_PERSONA = 'maya'

export default function SettingsPage() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [confirmText, setConfirmText] = useState('')

  const armed = confirmText.trim().toUpperCase() === 'RESET'

  async function reseed() {
    setStatus({ kind: 'busy' })
    try {
      const r = await apiPost<{ metrics: number }>('/api/demo/reseed')
      setStatus({
        kind: 'done',
        message: `Mock data regenerated — ${r.metrics} readings. Reload any page to see it.`,
      })
    } catch {
      setStatus({ kind: 'error', message: 'Reseed failed. Is DEMO_MODE on?' })
    }
  }

  async function reset() {
    setStatus({ kind: 'busy' })
    try {
      const r = await apiPost<{ usersDeleted: number }>('/api/demo/reset')
      setStatus({
        kind: 'done',
        message: `Master reset complete. Demo accounts removed: ${r.usersDeleted}. You have been signed out.`,
      })
      setConfirmText('')
    } catch {
      setStatus({ kind: 'error', message: 'Reset failed. Is DEMO_MODE on?' })
    }
  }

  return (
    <AppGate>
      <main>
        <h1>Settings</h1>

        <Preferences />

        <OpenRouterSettings />

        <section>
          <h2>Help &amp; tour</h2>
          <div className="card">
            <p>
              New here, or want a refresher? Replay the guided tour to see what each part of the
              app does and where everything lives.
            </p>
            <a className="btn-secondary" href="/dashboard?tour=1">
              Replay the guided tour
            </a>
          </div>
        </section>

        <section>
          <h2>Mock data</h2>
          <div className="card">
            <p>
              Everything you are looking at is generated demo data — 90 days of readings for a
              fictional account. It is deterministic, so regenerating produces the same numbers.
            </p>
            <button type="button" className="btn-secondary" onClick={reseed} disabled={status.kind === 'busy'}>
              Regenerate mock data
            </button>
          </div>
        </section>

        <section>
          <h2>Master reset</h2>
          <div className="card danger">
            <p>
              <strong>This deletes every demo account and all of its data.</strong> Metrics,
              medications, adherence history, appointments, assessments — all of it. Real
              accounts are not touched.
            </p>
            <p className="hint">
              This is the switch from exploring to real use. After running it, set{' '}
              <code>DEMO_MODE=false</code> and restart the API so these controls disappear
              entirely.
            </p>

            <label className="confirm-field">
              <span className="hint">Type RESET to confirm</span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="RESET"
                aria-label="Type RESET to confirm"
              />
            </label>

            <button
              type="button"
              className="btn-danger"
              onClick={reset}
              disabled={!armed || status.kind === 'busy'}
            >
              Delete all mock data
            </button>
          </div>
        </section>

        {status.kind === 'busy' && <p className="hint">Working…</p>}
        {status.kind === 'done' && (
          <div className="callout">
            <strong>Done.</strong>
            <p>{status.message}</p>
          </div>
        )}
        {status.kind === 'error' && (
          <div className="callout danger">
            <strong>That did not work.</strong>
            <p>{status.message}</p>
          </div>
        )}
      </main>
    </AppGate>
  )
}

interface Profile {
  timezone: string
}

function Preferences() {
  const toast = useToast()
  const [timezone, setTimezone] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [savingTz, setSavingTz] = useState(false)
  const [persona, setPersona] = useState(DEFAULT_PERSONA)

  useEffect(() => {
    let live = true
    apiGet<{ profile: Profile | null }>('/api/profile')
      .then((d) => {
        if (!live) return
        setTimezone(d.profile?.timezone ?? '')
        setLoaded(true)
      })
      .catch(() => {
        if (live) setLoaded(true)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const stored = window.localStorage.getItem(PERSONA_KEY)
    if (stored) setPersona(stored)
  }, [])

  async function saveTimezone() {
    setSavingTz(true)
    try {
      await apiPatch('/api/profile', { timezone: timezone.trim() })
      toast.show('Time zone saved.')
    } catch {
      toast.show('Could not save time zone.', 'err')
    } finally {
      setSavingTz(false)
    }
  }

  function selectPersona(id: string) {
    setPersona(id)
    window.localStorage.setItem(PERSONA_KEY, id)
    toast.show('Persona updated.')
  }

  return (
    <section>
      <h2>Preferences</h2>

      <div className="card stack">
        <div>
          <span className="hint">Appearance</span>
          <div style={{ marginTop: '0.4rem' }}>
            <ThemeToggle withLabel />
          </div>
          <p className="help-text">Switch between light and dark. Defaults to your device setting.</p>
        </div>
      </div>

      <div className="card stack">
        <label className="field">
          <span>Time zone</span>
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="e.g. America/New_York"
            disabled={!loaded}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={saveTimezone}
            disabled={!loaded || savingTz}
          >
            Save time zone
          </button>
        </div>
      </div>

      <h3>Assistant persona</h3>
      <p className="hint">Sets the tone your assistant uses. You can change it any time.</p>
      <div className="persona-grid">
        {SAMPLE_PERSONAS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`persona-card ${persona === p.id ? 'selected' : ''}`}
            onClick={() => selectPersona(p.id)}
            aria-pressed={persona === p.id}
          >
            <h3>{p.displayName}</h3>
            <p className="tagline">{p.tagline}</p>
            <div className="persona-traits">
              {p.traits.map((t) => (
                <span key={t} className="pill">
                  {t}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

interface AiSettings {
  configured: boolean
  keyHint: string | null
  keySource: 'user' | 'server' | null
  baseUrl: string
  modelChat: string
  modelExtract: string
  modelAnalyze: string
  modelVision: string
  userOverrides: {
    baseUrl: boolean
    modelChat: boolean
    modelExtract: boolean
    modelAnalyze: boolean
    modelVision: boolean
  }
}

function OpenRouterSettings() {
  const toast = useToast()
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<AiSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelChat, setModelChat] = useState('')
  const [modelExtract, setModelExtract] = useState('')
  const [modelAnalyze, setModelAnalyze] = useState('')
  const [modelVision, setModelVision] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    apiGet<{ ai: AiSettings }>('/api/settings/ai').then((d) => {
      setStatus(d.ai)
      setBaseUrl(d.ai.baseUrl)
      setModelChat(d.ai.modelChat)
      setModelExtract(d.ai.modelExtract)
      setModelAnalyze(d.ai.modelAnalyze)
      setModelVision(d.ai.modelVision)
      setLoaded(true)
    })

  useEffect(() => {
    let live = true
    load().catch(() => {
      if (live) setLoaded(true)
    })
    return () => {
      live = false
    }
  }, [])

  async function save() {
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        baseUrl: baseUrl.trim() || null,
        modelChat: modelChat.trim() || null,
        modelExtract: modelExtract.trim() || null,
        modelAnalyze: modelAnalyze.trim() || null,
        modelVision: modelVision.trim() || null,
      }
      const trimmedKey = apiKey.trim()
      if (trimmedKey.length >= 8) body.apiKey = trimmedKey

      await apiPut('/api/settings/ai', body)
      setApiKey('')
      await load()
      toast.show('AI settings saved.')
    } catch {
      toast.show('Could not save AI settings.', 'err')
    } finally {
      setBusy(false)
    }
  }

  async function removeKey() {
    if (status?.keySource !== 'user') return
    setBusy(true)
    try {
      await apiDelete('/api/settings/ai')
      await load()
      toast.show('Your OpenRouter key was removed.')
    } catch {
      toast.show('Could not remove the key.', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2>AI &amp; OpenRouter</h2>
      <div className="card stack">
        <div>
          <strong>OpenRouter</strong>
          <p className="help-text">
            Powers the assistant and document import. Your API key is encrypted at rest and never
            shown again after saving. Model and URL settings fall back to server defaults when
            left blank.{' '}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              Get a key at openrouter.ai
            </a>
          </p>
        </div>

        {!loaded ? (
          <p className="hint">Loading…</p>
        ) : status?.configured ? (
          <p className="hint">
            API key configured{status.keyHint ? ` (${status.keyHint})` : ''}
            {status.keySource === 'server' && ' — using a server-wide key from the environment'}
            {status.keySource === 'user' && ' — using your saved key'}
          </p>
        ) : (
          <p className="hint">No API key yet — add one below to enable the assistant and import.</p>
        )}

        <label className="field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={status?.configured ? 'Leave blank to keep current key' : 'sk-or-…'}
            autoComplete="off"
          />
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://openrouter.ai/api/v1"
          />
          {status?.userOverrides.baseUrl && (
            <p className="help-text">Using your custom base URL.</p>
          )}
        </label>

        <div className="form-grid">
          <ModelPicker
            label="Chat model"
            value={modelChat}
            onChange={setModelChat}
            placeholder="anthropic/claude-sonnet-4.5"
            modelsAvailable={status?.configured ?? false}
            disabled={!loaded || busy}
          />
          <ModelPicker
            label="Extract model"
            value={modelExtract}
            onChange={setModelExtract}
            placeholder="anthropic/claude-haiku-4.5"
            modelsAvailable={status?.configured ?? false}
            disabled={!loaded || busy}
          />
          <ModelPicker
            label="Analyze model"
            value={modelAnalyze}
            onChange={setModelAnalyze}
            placeholder="anthropic/claude-sonnet-4.5"
            modelsAvailable={status?.configured ?? false}
            disabled={!loaded || busy}
          />
          <ModelPicker
            label="Vision model"
            value={modelVision}
            onChange={setModelVision}
            placeholder="anthropic/claude-sonnet-4.5"
            modelsAvailable={status?.configured ?? false}
            disabled={!loaded || busy}
          />
        </div>

        {!status?.configured && (
          <p className="help-text">
            Add your OpenRouter API key above to browse models. You can still type a model id
            manually.
          </p>
        )}

        <p className="help-text">
          Clear a model field and save to revert that task to the server default.
        </p>

        <div className="form-actions">
          <button type="button" className="btn-primary" onClick={save} disabled={!loaded || busy}>
            {busy ? 'Saving…' : 'Save AI settings'}
          </button>
          {status?.keySource === 'user' && (
            <button type="button" className="btn-secondary" onClick={removeKey} disabled={busy}>
              Remove my key
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
