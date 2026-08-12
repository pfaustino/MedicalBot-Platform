'use client'

import { useCallback, useEffect, useState, type CSSProperties } from 'react'

/**
 * A lightweight spotlight tour. Each step optionally points at an element marked
 * with `data-tour="<key>"`; the element is highlighted and a tooltip explains it.
 * Steps whose anchor is missing or hidden (e.g. nav links collapsed on mobile)
 * fall back to a centered tooltip so the explanation still shows. It lives on the
 * dashboard, and the nav — which every step references — is on the same screen.
 */

interface Step {
  anchor?: string
  title: string
  body: string
}

function steps(isAdmin: boolean): Step[] {
  const base: Step[] = [
    {
      anchor: 'brand',
      title: 'Welcome to MedicalBot',
      body: 'This is your home base. Click the MedicalBot name any time to come back to your dashboard. Let’s take a quick look around.',
    },
    {
      anchor: 'log',
      title: 'Log anything, from anywhere',
      body: 'The + Log button is always here. Use it to record blood sugar, blood pressure, weight, sleep, mood, and more in a few seconds.',
    },
    {
      anchor: 'nav-metrics',
      title: 'Metrics',
      body: 'Every reading you log is charted over time against the target ranges your conditions set, so trends are easy to see.',
    },
    {
      anchor: 'nav-medications',
      title: 'Medications',
      body: 'Add your medications with real schedules, log each dose as taken or missed, and watch your adherence.',
    },
    {
      anchor: 'nav-assessments',
      title: 'Assessments',
      body: 'Take standardized check-ins like PHQ-9 and GAD-7. They’re scored instantly and trend alongside everything else.',
    },
    {
      anchor: 'nav-conditions',
      title: 'Conditions',
      body: 'See what you’re managing, what each condition tracks, and plain-language explanations to bring to your doctor.',
    },
    {
      anchor: 'nav-calendar',
      title: 'Calendar',
      body: 'Appointments, dated To Dos, and Google Calendar events in one place — with optional sync to your phone.',
    },
    {
      anchor: 'nav-records',
      title: 'Records',
      body: 'A printable health summary you can hand to a clinician — profile, conditions, medications, and recent labs.',
    },
    {
      anchor: 'fab-assistant',
      title: 'Assistant',
      body: 'The chat button in the bottom-right opens your assistant panel — ask questions, log readings, or change its personality any time.',
    },
    {
      anchor: 'nav-profile',
      title: 'Profile',
      body: 'Your details, allergies, and care team. Filling this in makes your summaries and targets more accurate.',
    },
    {
      anchor: 'nav-settings',
      title: 'Settings',
      body: 'Preferences, your assistant’s personality — and you can replay this tour here any time.',
    },
  ]
  if (isAdmin) {
    base.push({
      anchor: 'nav-admin',
      title: 'Admin',
      body: 'As an admin you get a platform overview and user management. The owner can grant admin access to others here.',
    })
  }
  base.push({
    title: 'You’re all set',
    body: 'Start by logging a reading or filling out your profile. You can replay this tour any time from Settings. Take care of yourself.',
  })
  return base
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function anchorRect(anchor?: string): Rect | null {
  if (!anchor) return null
  const el = document.querySelector(`[data-tour="${anchor}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null // hidden (e.g. collapsed menu)
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export function Tour({
  run,
  isAdmin,
  onClose,
}: {
  run: boolean
  isAdmin: boolean
  onClose: () => void
}) {
  const list = steps(isAdmin)
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)

  const step = list[i]

  const measure = useCallback(() => {
    setRect(anchorRect(step?.anchor))
  }, [step])

  useEffect(() => {
    if (!run) return
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [run, measure])

  // Reset to the first step whenever the tour is (re)started.
  useEffect(() => {
    if (run) setI(0)
  }, [run])

  const end = useCallback(() => {
    setI(0)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!run) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, end])

  if (!run || !step) return null

  const last = i === list.length - 1
  const next = () => (last ? end() : setI((n) => n + 1))
  const back = () => setI((n) => Math.max(0, n - 1))

  // Position the tooltip near the anchor when there is one, else center it.
  let tooltipStyle: CSSProperties | undefined
  let centered = true
  if (rect) {
    centered = false
    const belowRoom = window.innerHeight - (rect.top + rect.height)
    const placeBelow = belowRoom > 220
    const top = placeBelow ? rect.top + rect.height + 12 : Math.max(12, rect.top - 12)
    const transform = placeBelow ? undefined : 'translateY(-100%)'
    let left = rect.left
    // Keep the tooltip on screen horizontally.
    const maxLeft = window.innerWidth - Math.min(352, window.innerWidth - 32) - 12
    left = Math.min(Math.max(12, left), Math.max(12, maxLeft))
    tooltipStyle = { top, left, transform }
  }

  return (
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label="Guided tour">
      {rect ? (
        <div
          className="tour-highlight"
          style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
        />
      ) : (
        <div className="tour-scrim" />
      )}

      <div className={`tour-tooltip ${centered ? 'centered' : ''}`} style={tooltipStyle}>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-foot">
          <span className="tour-progress">
            Step {i + 1} of {list.length}
          </span>
          <div className="tour-nav">
            <button type="button" className="btn-ghost btn-sm" onClick={end}>
              {last ? 'Close' : 'Skip'}
            </button>
            {i > 0 && (
              <button type="button" className="btn-secondary btn-sm" onClick={back}>
                Back
              </button>
            )}
            <button type="button" className="btn-primary btn-sm" onClick={next}>
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
