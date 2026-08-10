'use client'

import { useRouter } from 'next/navigation'
import { FormEvent, useEffect, useState } from 'react'
import { apiErrorMessage, apiFetch, apiGet } from '@/lib/api'
import type { Me } from '../../components/useMe'

export default function AdminChangePasswordPage() {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    apiGet<Me>('/auth/me')
      .then((me) => {
        if (!me.isAdmin) {
          router.replace('/admin/login')
          return
        }
        if (!me.mustChangePassword && me.hasPassword) {
          router.replace('/admin')
          return
        }
        if (!me.mustChangePassword && !me.hasPassword) {
          router.replace('/admin/login')
        }
      })
      .catch(() => router.replace('/admin/login'))
      .finally(() => setChecking(false))
  }, [router])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.')
      return
    }

    setBusy(true)
    try {
      const res = await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError(apiErrorMessage(body) ?? 'Could not change password.')
        return
      }
      router.push('/admin')
    } catch {
      setError('Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  if (checking) {
    return (
      <main>
        <p className="hint">Loading…</p>
      </main>
    )
  }

  return (
    <main>
      <h1>Change password</h1>
      <p className="muted">
        You must set a new password before continuing. This is required after the initial bootstrap login.
      </p>

      <div className="card" style={{ maxWidth: '28rem' }}>
        <form onSubmit={(e) => void onSubmit(e)}>
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>
          {error && <p className="field-error">{error}</p>}
          <p>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save new password'}
            </button>
          </p>
        </form>
      </div>
    </main>
  )
}
