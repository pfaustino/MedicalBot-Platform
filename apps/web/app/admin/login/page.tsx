'use client'

import { useRouter } from 'next/navigation'
import { FormEvent, useState } from 'react'
import { apiErrorMessage, apiFetch } from '@/lib/api'

export default function AdminLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await apiFetch('/auth/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError(apiErrorMessage(body) ?? 'Sign-in failed.')
        return
      }
      const mustChange = Boolean(
        body && typeof body === 'object' && 'mustChangePassword' in body && body.mustChangePassword,
      )
      router.push(mustChange ? '/admin/change-password' : '/admin')
    } catch {
      setError('Could not reach the API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>Admin sign in</h1>
      <p className="muted">Platform administrators only. Personal users sign in with Google on the home page.</p>

      <div className="card" style={{ maxWidth: '28rem' }}>
        <form onSubmit={(e) => void onSubmit(e)}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="field-error">{error}</p>}
          <p>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>

      <p className="hint">
        <a href="/">← Back to home</a>
      </p>
    </main>
  )
}
