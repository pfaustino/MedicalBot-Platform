'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { apiFetch } from '@/lib/api'
import { Modal } from './Modal'
import { MetricEntryForm } from './MetricEntryForm'
import { ThemeToggle } from './ThemeToggle'
import { useMe } from './useMe'

const LINKS = [
  { href: '/dashboard', label: 'Dashboard', tour: 'nav-dashboard' },
  { href: '/assistant', label: 'Assistant', tour: 'nav-assistant' },
  { href: '/metrics', label: 'Metrics', tour: 'nav-metrics' },
  { href: '/medications', label: 'Medications', tour: 'nav-medications' },
  { href: '/assessments', label: 'Assessments', tour: 'nav-assessments' },
  { href: '/conditions', label: 'Conditions', tour: 'nav-conditions' },
  { href: '/appointments', label: 'Appointments', tour: 'nav-appointments' },
  { href: '/todos', label: 'To Dos', tour: 'nav-todos' },
  { href: '/records', label: 'Records', tour: 'nav-records' },
  { href: '/import', label: 'Import', tour: 'nav-import' },
  { href: '/profile', label: 'Profile', tour: 'nav-profile' },
  { href: '/settings', label: 'Settings', tour: 'nav-settings' },
]

const HIDDEN_ON = new Set(['/', '/terms', '/privacy', '/onboarding', '/admin/login', '/admin/change-password'])

export function Nav() {
  const pathname = usePathname()
  const me = useMe()
  const [menuOpen, setMenuOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)

  // The marketing page, legal pages, and the gated intake flow render bare.
  if (HIDDEN_ON.has(pathname)) return null

  const isAdmin = me.status === 'signed-in' && me.me.isAdmin

  async function signOut() {
    await apiFetch('/auth/logout', { method: 'POST' })
    window.location.href = '/'
  }

  return (
    <>
      <nav className="app-nav">
        <div className="app-nav-inner">
          <Link href="/dashboard" className="brand" data-tour="brand">
            MedicalBot
          </Link>

          <button
            type="button"
            className="nav-toggle"
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ☰
          </button>

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
            {isAdmin && (
              <li>
                <Link
                  href="/admin"
                  data-tour="nav-admin"
                  className={pathname.startsWith('/admin') ? 'active' : undefined}
                  onClick={() => setMenuOpen(false)}
                >
                  Admin
                </Link>
              </li>
            )}
          </ul>

          <div className="nav-right">
            <button
              type="button"
              className="btn-primary btn-sm"
              data-tour="log"
              onClick={() => setLogOpen(true)}
            >
              + Log
            </button>
            <ThemeToggle />
            <button type="button" className="btn-ghost btn-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <Modal open={logOpen} title="Log a reading" onClose={() => setLogOpen(false)} wide>
        <MetricEntryForm onDone={() => setLogOpen(false)} />
      </Modal>
    </>
  )
}
