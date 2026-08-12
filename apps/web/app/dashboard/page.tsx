'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { MetricEntryForm } from '../components/MetricEntryForm'
import { Tour } from '../components/Tour'
import { useToast } from '../components/Toast'
import { useMe } from '../components/useMe'
import { apiGet, NotAuthenticated } from '@/lib/api'
import { METRIC_LABELS, formatMetric } from '@/lib/format'

const TOUR_SEEN_KEY = 'medbot_tour_seen'

interface Tile {
  type: string
  targetMin: number | null
  targetMax: number | null
  latestValue: number | null
  latestSecondary: number | null
  latestAt: string | null
  latestContext: string | null
  unit: string | null
  count7d: number
  average7d: number | null
  inRange7d: number | null
}

interface Dashboard {
  displayName: string
  conditions: Array<{ key: string; label: string }>
  tiles: Tile[]
  adherence: {
    rate30d: number
    doses30d: number
    missed30d: number
    activeMedications: number
  }
  upcomingAppointments: Array<{
    id: string
    title: string
    startsAt: string
    location: string | null
  }>
}

export default function DashboardPage() {
  const toast = useToast()
  const me = useMe()
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [logging, setLogging] = useState(false)
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  const [tourRun, setTourRun] = useState(false)

  const isAdmin = me.status === 'signed-in' && me.me.isAdmin

  // First-login helper: offer the tour once. `?tour=1` (from Settings) replays it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('tour') === '1') {
      window.history.replaceState(null, '', '/dashboard')
      setTourRun(true)
      return
    }
    if (!localStorage.getItem(TOUR_SEEN_KEY)) setWelcomeOpen(true)
  }, [])

  const markTourSeen = () => localStorage.setItem(TOUR_SEEN_KEY, '1')

  const startTour = () => {
    markTourSeen()
    setWelcomeOpen(false)
    setTourRun(true)
  }

  const dismissWelcome = () => {
    markTourSeen()
    setWelcomeOpen(false)
  }

  // Refetch on reloadKey so a freshly logged reading shows up without a reload.
  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    apiGet<Dashboard>('/api/dashboard')
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(
            e instanceof NotAuthenticated ? 'Not signed in.' : 'Could not load your dashboard.',
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  return (
    <AppGate>
      <main>
        {error && <div className="card">{error}</div>}
        {!data && !error && <p className="hint">Loading…</p>}

        {data && (
          <>
            <div className="page-header">
              <div>
                <h1>Hello, {data.displayName}</h1>
                <p className="muted">
                  Tracking{' '}
                  {data.conditions.map((c) => c.label).join(' and ') || 'no conditions yet'}.
                </p>
              </div>
              <div className="page-actions">
                <button type="button" className="btn-primary" onClick={() => setLogging(true)}>
                  + Log reading
                </button>
              </div>
            </div>

            <div className="quick-actions">
              <button type="button" className="action-card" onClick={() => setLogging(true)}>
                <span className="action-icon">🩸</span>
                <span className="action-title">Log a reading</span>
                <span className="action-sub">Record a metric right now</span>
              </button>
              <Link href="/assessments" className="action-card">
                <span className="action-icon">📝</span>
                <span className="action-title">Take an assessment</span>
                <span className="action-sub">Check in on how you're doing</span>
              </Link>
              <Link href="/medications" className="action-card">
                <span className="action-icon">💊</span>
                <span className="action-title">Manage medications</span>
                <span className="action-sub">Doses, schedules, and refills</span>
              </Link>
              <Link href="/calendar" className="action-card">
                <span className="action-icon">📅</span>
                <span className="action-title">Calendar</span>
                <span className="action-sub">Visits, to-dos, and Google events</span>
              </Link>
              <Link href="/assistant" className="action-card">
                <span className="action-icon">💬</span>
                <span className="action-title">Chat with the assistant</span>
                <span className="action-sub">Ask about your tracked patterns</span>
              </Link>
            </div>

            <section>
              <h2>Last 7 days</h2>
              {data.tiles.every((t) => t.count7d === 0) ? (
                <p className="hint">No readings in the last week.</p>
              ) : (
                <div className="tile-grid">
                  {data.tiles
                    .filter((t) => t.count7d > 0)
                    .map((t) => (
                      <div key={t.type} className="tile">
                        <span className="tile-label">{METRIC_LABELS[t.type] ?? t.type}</span>
                        <span className="tile-value">
                          {formatMetric(t.type, t.latestValue, t.latestSecondary)}
                          {t.unit && t.unit !== 'mmHg' && (
                            <small> {t.unit.replace('score_', '').replace('_', '–')}</small>
                          )}
                        </span>
                        <span className="hint">
                          {t.count7d} reading{t.count7d === 1 ? '' : 's'}
                          {t.average7d !== null && ` · avg ${t.average7d}`}
                        </span>
                        {t.inRange7d !== null && (t.targetMin !== null || t.targetMax !== null) && (
                          <span
                            className={`badge ${t.inRange7d >= 0.7 ? 'badge-ok' : 'badge-warn'}`}
                          >
                            {Math.round(t.inRange7d * 100)}% in target
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </section>

            <section>
              <h2>Medications</h2>
              <div className="tile-grid">
                <div className="tile">
                  <span className="tile-label">Adherence, 30 days</span>
                  <span className="tile-value">{Math.round(data.adherence.rate30d * 100)}%</span>
                  <span className="hint">
                    {data.adherence.missed30d} of {data.adherence.doses30d} doses missed or skipped
                  </span>
                </div>
                <div className="tile">
                  <span className="tile-label">Active medications</span>
                  <span className="tile-value">{data.adherence.activeMedications}</span>
                  <span className="hint">
                    <a href="/medications">See the breakdown</a>
                  </span>
                </div>
              </div>
            </section>

            <section>
              <h2>Coming up</h2>
              {data.upcomingAppointments.length === 0 ? (
                <p className="hint">Nothing scheduled.</p>
              ) : (
                <ul className="plain-list">
                  {data.upcomingAppointments.map((a) => (
                    <li key={a.id}>
                      <strong>{a.title}</strong>
                      <span className="hint">
                        {new Date(a.startsAt).toLocaleString(undefined, {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                        {a.location && ` · ${a.location}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <Modal
          open={logging}
          title="Log a reading"
          onClose={() => setLogging(false)}
          wide
        >
          <MetricEntryForm
            onDone={() => {
              setLogging(false)
              setReloadKey((k) => k + 1)
              toast.show('Reading logged.')
            }}
          />
        </Modal>

        <Modal open={welcomeOpen} title="Welcome to MedicalBot 👋" onClose={dismissWelcome}>
          <p>
            This is your personal health companion — log readings, track medications, take
            check-ins, and keep everything ready for your next visit.
          </p>
          <p className="hint">
            Want a quick guided tour of how it all fits together? It takes about a minute.
          </p>
          <div className="form-actions">
            <button type="button" className="btn-primary" onClick={startTour}>
              Take the tour
            </button>
            <button type="button" className="btn-secondary" onClick={dismissWelcome}>
              Explore on my own
            </button>
          </div>
        </Modal>

        <Tour
          run={tourRun}
          isAdmin={isAdmin}
          onClose={() => {
            markTourSeen()
            setTourRun(false)
          }}
        />
      </main>
    </AppGate>
  )
}
