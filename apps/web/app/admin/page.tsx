'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '../components/Toast'
import { useMe } from '../components/useMe'
import { apiGet, apiPost } from '@/lib/api'
import { formatDate } from '@/lib/format'

interface AdminUser {
  id: string
  email: string
  role: 'user' | 'admin' | 'owner'
  isDemo: boolean
  createdAt: string
  onboardedAt: string | null
}

interface Overview {
  stats: {
    users: number
    plainUsers: number
    admins: number
    demoAccounts: number
    metrics: number
    medications: number
    assessments: number
  }
  users: AdminUser[]
}

const ROLE_BADGE: Record<string, string> = {
  owner: 'badge badge-ok',
  admin: 'badge badge-warn',
  user: 'badge',
}

export default function AdminPage() {
  return <AdminInner />
}

function AdminInner() {
  const router = useRouter()
  const me = useMe()
  const toast = useToast()
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<'forbidden' | 'other' | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const isOwner = me.status === 'signed-in' && me.me.role === 'owner'
  const myId = me.status === 'signed-in' ? me.me.id : null

  const load = useCallback(() => {
    setData(null)
    setError(null)
    apiGet<Overview>('/api/admin/overview')
      .then(setData)
      .catch((e) => setError(e?.status === 403 ? 'forbidden' : 'other'))
  }, [])

  useEffect(() => {
    if (me.status === 'loading') return
    if (me.status === 'anon') {
      router.replace('/admin/login')
      return
    }
    if (me.me.mustChangePassword) {
      router.replace('/admin/change-password')
      return
    }
    if (!me.me.isAdmin) {
      setError('forbidden')
      return
    }
    load()
  }, [me, load, router])

  const changeRole = useCallback(
    async (user: AdminUser, role: 'user' | 'admin') => {
      setBusyId(user.id)
      try {
        await apiPost(`/api/admin/users/${user.id}/role`, { role })
        toast.show(`${user.email} is now ${role === 'admin' ? 'an admin' : 'a user'}.`)
        load()
      } catch {
        toast.show('Could not change that role.', 'err')
      } finally {
        setBusyId(null)
      }
    },
    [toast, load],
  )

  if (me.status === 'loading' || (me.status === 'signed-in' && me.me.mustChangePassword)) {
    return (
      <main>
        <p className="hint">Loading…</p>
      </main>
    )
  }

  if (me.status === 'anon') {
    return (
      <main>
        <p className="hint">Redirecting to sign in…</p>
      </main>
    )
  }

  if (error === 'forbidden') {
    return (
      <main>
        <h1>Admin</h1>
        <div className="card">
          <p>
            <strong>You don&apos;t have access to this section.</strong>
          </p>
          <p className="hint">
            The administrator area is limited to admins and the software owner. If you think you
            should have access, ask the owner to grant it from this page.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main>
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p className="muted">
            Platform overview and user management.
            {isOwner ? ' As the owner, you can grant or revoke admin access.' : ' Read-only for admins.'}
          </p>
          {me.status === 'signed-in' && me.me.hasPassword && (
            <p className="hint">
              <a href="/admin/change-password">Change admin password</a>
            </p>
          )}
        </div>
      </div>

      {error === 'other' && <div className="card">Could not load the admin overview.</div>}
      {!data && !error && <p className="hint">Loading…</p>}

      {data && (
        <>
          <section>
            <h2>At a glance</h2>
            <div className="tile-grid">
              <Stat label="Total users" value={data.stats.users} />
              <Stat label="Admins" value={data.stats.admins} />
              <Stat label="Demo accounts" value={data.stats.demoAccounts} />
              <Stat label="Readings logged" value={data.stats.metrics} />
              <Stat label="Medications" value={data.stats.medications} />
              <Stat label="Assessments taken" value={data.stats.assessments} />
            </div>
          </section>

          <section>
            <h2>Users ({data.users.length})</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th>Onboarded</th>
                    {isOwner && <th>Manage</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.email}
                        {u.isDemo && <span className="hint"> · demo</span>}
                        {u.id === myId && <span className="hint"> · you</span>}
                      </td>
                      <td>
                        <span className={ROLE_BADGE[u.role] ?? 'badge'}>{u.role}</span>
                      </td>
                      <td>{formatDate(u.createdAt)}</td>
                      <td>{u.onboardedAt ? formatDate(u.onboardedAt) : '—'}</td>
                      {isOwner && (
                        <td>
                          {u.role === 'owner' || u.id === myId ? (
                            <span className="hint">—</span>
                          ) : u.role === 'admin' ? (
                            <button
                              type="button"
                              className="btn-ghost btn-sm"
                              disabled={busyId === u.id}
                              onClick={() => void changeRole(u, 'user')}
                            >
                              Revoke admin
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              disabled={busyId === u.id}
                              onClick={() => void changeRole(u, 'admin')}
                            >
                              Make admin
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!isOwner && (
              <p className="hint">Only the owner can change roles.</p>
            )}
          </section>
        </>
      )}
    </main>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value.toLocaleString()}</span>
    </div>
  )
}
