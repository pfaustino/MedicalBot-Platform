'use client'

import { useState } from 'react'
import { AppGate } from '../components/AppGate'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { Loaded } from '../components/Loader'
import { apiPost, apiPatch, apiDelete } from '@/lib/api'
import { formatDate } from '@/lib/format'

interface Todo {
  id: string
  title: string
  notes: string | null
  dueAt: string | null
  status: 'open' | 'done' | 'cancelled'
  source: 'manual' | 'import'
  sourceDocument: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const head = iso.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : ''
}

function TodoCard({ t, onChanged }: { t: Todo; onChanged: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(t.title)
  const [notes, setNotes] = useState(t.notes ?? '')
  const [dueAt, setDueAt] = useState(toDateInputValue(t.dueAt))
  const done = t.status === 'done'
  const cancelled = t.status === 'cancelled'

  async function setStatus(status: Todo['status']) {
    if (busy) return
    setBusy(true)
    try {
      await apiPatch(`/api/todos/${t.id}`, { status })
      toast.show(status === 'done' ? 'Marked done.' : status === 'open' ? 'Reopened.' : 'Cancelled.', 'ok')
      onChanged()
    } catch {
      toast.show('Could not update that to-do.', 'err')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    if (!window.confirm(`Delete “${t.title}”?`)) return
    setBusy(true)
    try {
      await apiDelete(`/api/todos/${t.id}`)
      toast.show('To-do deleted.', 'ok')
      onChanged()
    } catch {
      toast.show('Could not delete that to-do.', 'err')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    if (!title.trim()) {
      toast.show('A title is required.', 'err')
      return
    }
    setBusy(true)
    try {
      await apiPatch(`/api/todos/${t.id}`, {
        title: title.trim(),
        notes: notes.trim() || null,
        dueAt: dueAt ? new Date(`${dueAt}T12:00:00`).toISOString() : null,
      })
      toast.show('To-do updated.', 'ok')
      setEditing(false)
      onChanged()
    } catch {
      toast.show('Could not save changes.', 'err')
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="card">
        <div className="form-grid">
          <label className="field">
            <span>Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>Due (optional)</span>
            <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Notes (optional)</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </label>
        <div className="btn-row">
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void saveEdit()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              setTitle(t.title)
              setNotes(t.notes ?? '')
              setDueAt(toDateInputValue(t.dueAt))
              setEditing(false)
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`card${done || cancelled ? ' muted' : ''}`}>
      <div className="card-head">
        <div>
          <h3 style={done ? { textDecoration: 'line-through' } : undefined}>{t.title}</h3>
          <p className="hint">
            {t.dueAt ? `Due ${formatDate(t.dueAt)}` : 'No due date'}
            {t.source === 'import' && t.sourceDocument ? ` · from ${t.sourceDocument}` : ''}
            {t.source === 'import' && !t.sourceDocument ? ' · from import' : ''}
            {done && t.completedAt ? ` · done ${formatDate(t.completedAt)}` : ''}
          </p>
        </div>
        <span className={`badge${done ? ' badge-ok' : cancelled ? ' badge-warn' : ''}`}>
          {t.status}
        </span>
      </div>

      {t.notes && <p className="hint">{t.notes}</p>}

      <div className="btn-row">
        {t.status === 'open' && (
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void setStatus('done')}>
            Mark done
          </button>
        )}
        {t.status === 'done' && (
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void setStatus('open')}>
            Reopen
          </button>
        )}
        {t.status === 'open' && (
          <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void setStatus('cancelled')}>
            Cancel
          </button>
        )}
        {t.status === 'cancelled' && (
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void setStatus('open')}>
            Reopen
          </button>
        )}
        <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="btn-ghost btn-sm" disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </div>
    </div>
  )
}

function TodoForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!title.trim()) {
      setError('A title is required.')
      return
    }
    setBusy(true)
    try {
      await apiPost('/api/todos', {
        title: title.trim(),
        notes: notes.trim() || null,
        dueAt: dueAt ? new Date(`${dueAt}T12:00:00`).toISOString() : null,
      })
      onDone()
    } catch {
      setError('Could not save that to-do. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="form-grid">
        <label className="field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Schedule fasting labs"
            autoFocus
          />
        </label>
        <label className="field">
          <span>Due (optional)</span>
          <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Notes (optional)</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Context, who to call, what to bring."
          rows={3}
        />
      </label>
      {error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add to-do'}
        </button>
      </div>
    </form>
  )
}

export default function TodosPage() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const refetch = () => setReloadKey((k) => k + 1)

  return (
    <AppGate>
      <main>
        <div className="page-header">
          <div>
            <h1>To Dos</h1>
            <p className="muted">Follow-ups you add yourself, plus action items from document import.</p>
          </div>
          <div className="page-actions">
            <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
              + Add to-do
            </button>
          </div>
        </div>

        <Loaded<{ todos: Todo[] }> key={reloadKey} path="/api/todos">
          {(d) => {
            const openTodos = d.todos.filter((t) => t.status === 'open')
            const closed = d.todos.filter((t) => t.status !== 'open')
            return (
              <>
                <section>
                  <h2>Open</h2>
                  {openTodos.length === 0 ? (
                    <p className="hint">Nothing open. Add a to-do or import a visit summary.</p>
                  ) : (
                    <div className="stack">
                      {openTodos.map((t) => (
                        <TodoCard key={t.id} t={t} onChanged={refetch} />
                      ))}
                    </div>
                  )}
                </section>

                {closed.length > 0 && (
                  <section>
                    <h2>Done & cancelled</h2>
                    <div className="stack">
                      {closed.map((t) => (
                        <TodoCard key={t.id} t={t} onChanged={refetch} />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )
          }}
        </Loaded>

        <Modal open={open} title="Add to-do" onClose={() => setOpen(false)} wide>
          <TodoForm
            onDone={() => {
              setOpen(false)
              refetch()
              toast.show('To-do added.', 'ok')
            }}
          />
        </Modal>
      </main>
    </AppGate>
  )
}
