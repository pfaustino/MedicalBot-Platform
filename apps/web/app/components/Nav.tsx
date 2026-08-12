'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { Modal } from './Modal'
import { MetricEntryForm } from './MetricEntryForm'
import { ThemeToggle } from './ThemeToggle'
import { useMe } from './useMe'

const LINKS = [
  { href: '/dashboard', label: 'Dashboard', tour: 'nav-dashboard' },
  { href: '/metrics', label: 'Metrics', tour: 'nav-metrics' },
  { href: '/medications', label: 'Medications', tour: 'nav-medications' },
  { href: '/assessments', label: 'Assessments', tour: 'nav-assessments' },
  { href: '/conditions', label: 'Conditions', tour: 'nav-conditions' },
  { href: '/calendar', label: 'Calendar', tour: 'nav-calendar' },
  { href: '/todos', label: 'To Dos', tour: 'nav-todos' },
  { href: '/records', label: 'Records', tour: 'nav-records' },
  { href: '/import', label: 'Import', tour: 'nav-import' },
]

const HIDDEN_ON = new Set(['/', '/terms', '/privacy', '/onboarding', '/admin/login', '/admin/change-password'])

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19.5a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H4.5a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9.5a1.65 1.65 0 0 0 1-1.51V4.5a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9.5a1.65 1.65 0 0 0 1.51 1h.09a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function initialsFrom(email: string, displayName: string | null): string {
  const source = (displayName ?? email).trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export function Nav() {
  const pathname = usePathname()
  const me = useMe()
  const [menuOpen, setMenuOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)

  const hidden = HIDDEN_ON.has(pathname)
  const isAdmin = me.status === 'signed-in' && me.me.isAdmin
  const avatarUrl = me.status === 'signed-in' ? me.me.avatarUrl : null
  const displayName = me.status === 'signed-in' ? me.me.displayName : null
  const email = me.status === 'signed-in' ? me.me.email : ''

  useEffect(() => {
    if (!settingsOpen) return
    function onPointerDown(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [settingsOpen])

  async function signOut() {
    setSettingsOpen(false)
    await apiFetch('/auth/logout', { method: 'POST' })
    window.location.href = '/'
  }

  // The marketing page, legal pages, and the gated intake flow render bare.
  if (hidden) return null

  return (
    <>
      <nav className="app-nav">
        <div className="app-nav-inner">
          <div className="nav-bar">
            <Link href="/dashboard" className="brand" data-tour="brand">
              MedicalBot
            </Link>

            <div className="nav-right">
              <button
                type="button"
                className="nav-toggle"
                aria-label="Toggle menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                ☰
              </button>
              <button
                type="button"
                className="btn-primary btn-sm"
                data-tour="log"
                onClick={() => setLogOpen(true)}
              >
                + Log
              </button>
              <ThemeToggle />

              <div className="nav-settings" ref={settingsRef}>
                <button
                  type="button"
                  className="nav-icon-btn"
                  data-tour="nav-settings"
                  aria-label="Settings"
                  aria-expanded={settingsOpen}
                  aria-haspopup="menu"
                  onClick={() => setSettingsOpen((v) => !v)}
                >
                  <GearIcon />
                </button>
                {settingsOpen && (
                  <div className="nav-settings-menu" role="menu">
                    <Link href="/settings" role="menuitem" onClick={() => setSettingsOpen(false)}>
                      Settings
                    </Link>
                    {isAdmin && (
                      <Link
                        href="/admin"
                        role="menuitem"
                        data-tour="nav-admin"
                        onClick={() => setSettingsOpen(false)}
                      >
                        Admin
                      </Link>
                    )}
                    <button type="button" role="menuitem" onClick={() => void signOut()}>
                      Sign out
                    </button>
                  </div>
                )}
              </div>

              <Link
                href="/profile"
                className="nav-avatar"
                data-tour="nav-profile"
                aria-label="Profile"
                title={(displayName ?? email) || 'Profile'}
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="nav-avatar-fallback" aria-hidden="true">
                    {initialsFrom(email, displayName)}
                  </span>
                )}
              </Link>
            </div>
          </div>

          <ul className={`nav-links ${menuOpen ? 'open' : ''}`}>
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  data-tour={link.tour}
                  className={pathname.startsWith(link.href) ? 'active' : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <Modal open={logOpen} title="Log a reading" onClose={() => setLogOpen(false)} wide>
        <MetricEntryForm onDone={() => setLogOpen(false)} />
      </Modal>
    </>
  )
}
