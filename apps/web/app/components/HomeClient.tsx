'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { PRODUCT_DESCRIPTION_SHORT } from '@medbot/shared'
import { API_URL, apiFetch } from '../../lib/api'
import { TermsModal } from './TermsModal'

interface LegalPayload {
  version: string
  summary: {
    title: string
    intro: string
    sections: Array<{ heading: string; body: string }>
    checkboxLabel: string
  }
  loginReminder: string
}

interface MeResponse {
  id: string
  email: string
  needsTermsAcceptance: boolean
  onboardedAt: string | null
}

export function HomeClient() {
  const [legal, setLegal] = useState<LegalPayload | null>(null)
  const [user, setUser] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [signupAgreed, setSignupAgreed] = useState(false)
  const [showSignupTerms, setShowSignupTerms] = useState(false)
  const [demoAvailable, setDemoAvailable] = useState(false)
  const [googleAvailable, setGoogleAvailable] = useState(false)
  const [demoBusy, setDemoBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [signinNotice, setSigninNotice] = useState<string | null>(null)

  const loadSession = useCallback(async () => {
    setLoadError(null)
    try {
      const [legalRes, meRes, healthRes] = await Promise.all([
        apiFetch('/legal'),
        apiFetch('/auth/me'),
        apiFetch('/health'),
      ])
      if (legalRes.ok) setLegal(await legalRes.json())
      else {
        setLoadError(
          'Could not reach the API. Start it with npm run dev:api (port 3001), then refresh.',
        )
      }
      if (meRes.ok) setUser(await meRes.json())
      else setUser(null)
      if (healthRes.ok) {
        const health = (await healthRes.json()) as {
          checks?: { demoMode?: boolean; google?: boolean }
        }
        const google = Boolean(health.checks?.google)
        setGoogleAvailable(google)
        setDemoAvailable(Boolean(health.checks?.demoMode) || !google)
      }
    } catch {
      setLoadError(
        'Could not reach the API. Start it with npm run dev:api (port 3001), then refresh.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const enterDemo = useCallback(async () => {
    setDemoBusy(true)
    const res = await apiFetch('/auth/demo', { method: 'POST', body: '{}' })
    if (res.ok) window.location.href = '/dashboard'
    else setDemoBusy(false)
  }, [])

  const acceptTerms = useCallback(async () => {
    const res = await apiFetch('/auth/accept-terms', { method: 'POST' })
    if (res.ok) await loadSession()
  }, [loadSession])

  useEffect(() => {
    void loadSession()
    const params = new URLSearchParams(window.location.search)
    if (params.get('signin') === 'google-unconfigured') {
      setSigninNotice('Google sign-in is not set up on this server. Use Enter demo below.')
      window.history.replaceState({}, '', '/')
    }
  }, [loadSession])

  // After OAuth, auto-record acceptance if the user agreed on the signup screen.
  useEffect(() => {
    if (!user?.needsTermsAcceptance || !legal) return
    const pre = sessionStorage.getItem('terms_preconsent')
    if (pre === legal.version) {
      sessionStorage.removeItem('terms_preconsent')
      void acceptTerms()
    }
  }, [user, legal, acceptTerms])

  const signOut = async () => {
    await apiFetch('/auth/logout', { method: 'POST' })
    setUser(null)
    setSignupAgreed(false)
  }

  if (loading) {
    return <p className="muted">Loading…</p>
  }

  if (loadError || !legal) {
    return (
      <div className="notice">
        <strong>API not reachable</strong>
        <p>{loadError ?? 'The backend did not respond.'}</p>
        <p className="hint">
          In development, run <code>npm run dev:api</code> in one terminal and{' '}
          <code>npm run dev:web</code> in another, then refresh this page.
        </p>
      </div>
    )
  }

  const signedIn = Boolean(user)
  const needsAcceptance = signedIn && user!.needsTermsAcceptance
  // Terms come first; once accepted, an un-onboarded user is sent to intake
  // rather than a dashboard that has nothing to show yet.
  const needsOnboarding = signedIn && !needsAcceptance && !user!.onboardedAt

  return (
    <>
      {signedIn && !needsAcceptance && (
        <div className="login-banner" role="status">
          <strong>Reminder:</strong> {legal.loginReminder}{' '}
          <Link href="/terms">Terms</Link>
        </div>
      )}

      <h1>MedicalBot</h1>
      <p className="muted">{PRODUCT_DESCRIPTION_SHORT}</p>

      {signedIn ? (
        <div className="card">
          <p>Signed in as <strong>{user!.email}</strong></p>
          {needsOnboarding ? (
            <>
              <p className="hint">One quick step left before your dashboard is ready.</p>
              <p>
                <Link className="btn-primary" href="/onboarding">
                  Finish setting up your account
                </Link>
              </p>
            </>
          ) : (
            <p>
              <Link className="btn-primary" href="/dashboard">
                Open the dashboard
              </Link>
            </p>
          )}
          <button type="button" className="btn-secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      ) : (
        <div className="card">
          <p>
            <strong>Phase 1 — foundation.</strong> Auth, schema, and the API are in place.
            Metric tracking and the assistant come next.
          </p>

          {signinNotice && <p className="field-error">{signinNotice}</p>}

          {googleAvailable ? (
            signupAgreed ? (
              <p>
                <a className="btn-primary" href={`${API_URL}/auth/google`}>
                  Sign in with Google
                </a>
              </p>
            ) : (
              <p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setShowSignupTerms(true)}
                >
                  Create account / Sign in
                </button>
              </p>
            )
          ) : (
            <p className="hint">
              Google sign-in is not configured locally. Use <strong>Enter demo</strong> below —
              no Google account needed.
            </p>
          )}

          {googleAvailable && (
            <p className="hint">
              You must review and accept our Terms before signing in.
            </p>
          )}
        </div>
      )}

      {demoAvailable && !signedIn && (
        <div className="card">
          <strong>{googleAvailable ? 'Explore with mock data' : 'Sign in to explore'}</strong>
          <p className="hint">
            Signs you into a demo account preloaded with 90 days of generated readings — no
            Google account needed. Clear it any time from Settings.
          </p>
          <button type="button" className={googleAvailable ? 'btn-secondary' : 'btn-primary'} onClick={() => void enterDemo()}>
            {demoBusy ? 'Loading…' : 'Enter demo'}
          </button>
        </div>
      )}

      <div className="card">
        <strong>What this will track</strong>
        <ul>
          <li>Blood glucose with meal context, weight, blood pressure, labs</li>
          <li>Medications and adherence, including why a dose was missed</li>
          <li>Sleep, mood, and side effects</li>
          <li>Standardized assessments (PHQ-9, GAD-7) trended over time</li>
          <li>Appointments, synced with Google Calendar</li>
          <li>An assistant with a personality you choose — warm, direct, professional, or your own</li>
          <li>Conditions, prescriptions, labs, doctor&apos;s orders, and visits — with glossaries that explain what they mean</li>
          <li>Diet, exercise, and sleep — meals, workouts, and weekly activity summaries</li>
        </ul>
      </div>

      <div className="notice">
        <strong>Not a medical device.</strong> It tracks your data and shows you patterns.
        It does not diagnose or prescribe, and it does not replace your care team.
        It is not HIPAA-certified.
      </div>

      <TermsModal
        summary={legal.summary}
        mode="signup"
        open={showSignupTerms}
        onCancel={() => setShowSignupTerms(false)}
        onAccept={() => {
          sessionStorage.setItem('terms_preconsent', legal.version)
          setSignupAgreed(true)
          setShowSignupTerms(false)
        }}
      />

      <TermsModal
        summary={legal.summary}
        mode="accept"
        open={needsAcceptance}
        onAccept={() => void acceptTerms()}
      />
    </>
  )
}
