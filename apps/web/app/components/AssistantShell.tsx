'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { SAMPLE_PERSONAS, getPersonaById, type AssistantPersona } from '@medbot/shared'
import { apiDelete, apiErrorMessage, apiGet, apiPost, apiPostBlob, ApiError } from '@/lib/api'
import { useAssistant } from './AssistantContext'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useMe } from './useMe'

const HIDDEN_ON = new Set([
  '/',
  '/terms',
  '/privacy',
  '/onboarding',
  '/admin/login',
  '/admin/change-password',
])

const PERSONA_STORAGE_KEY = 'medbot_persona'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  actions?: string[]
}

let messageId = 1

function greeting(persona: AssistantPersona): string {
  return `Hi, I'm ${persona.displayName}. Tell me how you're doing, or just ask — I can log a reading ("my sugar was 142 before dinner"), add a medication, note that you took a dose, book an appointment, or pull up your trends. What's on your mind?`
}

const SUGGESTIONS = [
  'Log my blood sugar at 132 before dinner',
  'What medications am I on?',
  'How has my blood pressure been this week?',
]

interface Diagnostics {
  configured?: boolean
  ok?: boolean
  message?: string
  chatModel?: string
  respondedAs?: string
  sample?: string
  detail?: string
  status?: number
}

function ChatIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4.5 5.75A2.25 2.25 0 0 1 6.75 3.5h10.5A2.25 2.25 0 0 1 19.5 5.75v8.5A2.25 2.25 0 0 1 17.25 16.5H9.3l-3.6 3.15a.75.75 0 0 1-1.2-.6V5.75Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Floating assistant FAB + right drawer. Mounted once in Providers so chat state
 * survives navigation; UI is hidden on marketing/legal/auth paths and when signed out.
 */
export function AssistantShell() {
  const pathname = usePathname()
  const me = useMe()
  const toast = useToast()
  const { open, openAssistant, closeAssistant } = useAssistant()

  const [personaId, setPersonaId] = useState('maya')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [testing, setTesting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speakingId, setSpeakingId] = useState<number | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const historyLoaded = useRef(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaChunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const isAdmin = me.status === 'signed-in' && me.me.isAdmin
  const persona = getPersonaById(personaId) ?? SAMPLE_PERSONAS[0]

  // Load history once when the user becomes signed-in (shell stays mounted across routes).
  useEffect(() => {
    if (me.status !== 'signed-in') {
      if (me.status === 'anon') historyLoaded.current = false
      return
    }
    if (historyLoaded.current) return
    historyLoaded.current = true

    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(PERSONA_STORAGE_KEY) : null
    const resolved = getPersonaById(saved ?? '') ?? SAMPLE_PERSONAS[0]
    setPersonaId(resolved.id)

    apiGet<{ messages: Array<{ role: string; content: string }>; configured: boolean }>(
      '/api/assistant/history',
    )
      .then((d) => {
        setConfigured(d.configured)
        if (d.messages.length) {
          setMessages(
            d.messages.map((m) => ({
              id: messageId++,
              role: m.role === 'user' ? 'user' : 'assistant',
              text: m.content,
            })),
          )
        } else {
          setMessages([{ id: messageId++, role: 'assistant', text: greeting(resolved) }])
        }
      })
      .catch(() => {
        setConfigured(true)
        setMessages([{ id: messageId++, role: 'assistant', text: greeting(resolved) }])
      })
  }, [me.status])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, sending, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pickerOpen) closeAssistant()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, pickerOpen, closeAssistant])

  async function send(text: string) {
    const body = text.trim()
    if (!body || sending) return
    setMessages((prev) => [...prev, { id: messageId++, role: 'user', text: body }])
    setDraft('')
    setSending(true)
    try {
      const res = await apiPost<{ reply: string; actions: string[]; model: string }>(
        '/api/assistant/chat',
        { message: body, personaId },
      )
      setConfigured(true)
      setMessages((prev) => [
        ...prev,
        { id: messageId++, role: 'assistant', text: res.reply, actions: res.actions },
      ])
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setConfigured(false)
        setMessages((prev) => [
          ...prev,
          {
            id: messageId++,
            role: 'assistant',
            text: 'Add your OpenRouter API key in Settings before I can chat. Everything else in the app works in the meantime.',
          },
        ])
      } else {
        const detail =
          e instanceof ApiError && e.body && typeof e.body === 'object' && 'error' in e.body
            ? String((e.body as { error?: unknown }).error)
            : null
        setMessages((prev) => [
          ...prev,
          {
            id: messageId++,
            role: 'assistant',
            text: detail ?? 'Sorry — I had trouble responding. Please try again.',
          },
        ])
        toast.show('Assistant error.', 'err')
      }
    } finally {
      setSending(false)
    }
  }

  async function testConnection() {
    setTesting(true)
    setDiag(null)
    try {
      const r = await apiGet<Diagnostics>('/api/assistant/diagnostics')
      setDiag(r)
    } catch (e) {
      setDiag({
        ok: false,
        message:
          e instanceof ApiError && e.status === 403
            ? 'Only an admin/owner can run the connection test.'
            : 'Could not run the connection test.',
      })
    } finally {
      setTesting(false)
    }
  }

  async function clearChat() {
    try {
      await apiDelete('/api/assistant/history')
    } catch {
      /* clearing locally is enough even if the request fails */
    }
    setMessages([{ id: messageId++, role: 'assistant', text: greeting(persona) }])
    toast.show('Conversation cleared.')
  }

  function choosePersona(next: AssistantPersona) {
    setPersonaId(next.id)
    if (typeof window !== 'undefined') window.localStorage.setItem(PERSONA_STORAGE_KEY, next.id)
    setPickerOpen(false)
    toast.show(`Now chatting with ${next.displayName}.`)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(draft)
    }
  }

  function stopSpeaking() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setSpeakingId(null)
  }

  async function speakText(id: number, text: string) {
    if (speakingId === id) {
      stopSpeaking()
      return
    }
    stopSpeaking()
    setSpeakingId(id)
    try {
      const blob = await apiPostBlob('/api/assistant/speech', { text })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        URL.revokeObjectURL(url)
        if (audioRef.current === audio) {
          audioRef.current = null
          setSpeakingId(null)
        }
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        toast.show('Could not play speech.', 'err')
        setSpeakingId(null)
      }
      await audio.play()
    } catch (e) {
      const detail =
        e instanceof ApiError ? apiErrorMessage(e.body) : null
      toast.show(detail ?? 'Could not speak that reply.', 'err')
      setSpeakingId(null)
    }
  }

  async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('Could not read recording'))
      reader.readAsDataURL(blob)
    })
  }

  async function finishRecording(blob: Blob) {
    setTranscribing(true)
    try {
      const dataUrl = await blobToDataUrl(blob)
      const res = await apiPost<{ text: string }>('/api/assistant/transcribe', {
        mimeType: blob.type || 'audio/webm',
        dataUrl,
      })
      const text = res.text.trim()
      if (!text) {
        toast.show('Could not hear any speech. Try again.', 'err')
        return
      }
      setDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
    } catch (e) {
      const detail = e instanceof ApiError ? apiErrorMessage(e.body) : null
      toast.show(detail ?? 'Could not transcribe audio.', 'err')
    } finally {
      setTranscribing(false)
    }
  }

  async function toggleMic() {
    if (recording) {
      mediaRecorderRef.current?.stop()
      return
    }
    if (configured === false || sending || transcribing) return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast.show('Microphone is not available in this browser.', 'err')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      mediaChunksRef.current = []
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) mediaChunksRef.current.push(ev.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        mediaRecorderRef.current = null
        const blob = new Blob(mediaChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        })
        mediaChunksRef.current = []
        if (blob.size > 0) void finishRecording(blob)
      }
      mediaRecorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch {
      toast.show('Microphone permission was denied.', 'err')
    }
  }

  useEffect(() => {
    return () => {
      stopSpeaking()
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
    }
  }, [])

  if (HIDDEN_ON.has(pathname) || me.status !== 'signed-in') return null

  return (
    <>
      {!open && (
        <button
          type="button"
          className="assistant-fab"
          data-tour="fab-assistant"
          aria-label="Open assistant"
          onClick={openAssistant}
        >
          <ChatIcon />
        </button>
      )}

      {open && (
        <>
          <div className="assistant-backdrop" onClick={closeAssistant} aria-hidden="true" />
          <aside
            className="assistant-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Assistant"
          >
            <div className="assistant-drawer-header">
              <div>
                <h2>{persona.displayName}</h2>
                <p className="muted">{persona.tagline}</p>
              </div>
              <div className="page-actions">
                {isAdmin && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => void testConnection()}
                    disabled={testing}
                  >
                    {testing ? 'Testing…' : 'Test connection'}
                  </button>
                )}
                <button type="button" className="btn-ghost btn-sm" onClick={() => void clearChat()}>
                  Clear
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => setPickerOpen(true)}>
                  Change persona
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={closeAssistant}
                  aria-label="Close assistant"
                >
                  Close
                </button>
              </div>
            </div>

            {configured === false && (
              <div className="callout danger">
                <strong>Assistant not enabled.</strong>
                <p>
                  Add your OpenRouter API key in <a href="/settings">Settings</a> to turn on live
                  conversation. Everything else in the app works without it.
                </p>
              </div>
            )}

            {diag && (
              <div className={`callout ${diag.ok ? '' : 'danger'}`}>
                <strong>{diag.ok ? 'Connection OK' : 'Connection problem'}</strong>
                <p>
                  {diag.ok
                    ? `${diag.respondedAs ?? diag.chatModel ?? 'The model'} responded${diag.sample ? ` — “${diag.sample}”` : ''}.`
                    : diag.message}
                </p>
                {diag.chatModel && (
                  <p className="hint">
                    Configured chat model: <code>{diag.chatModel}</code>
                  </p>
                )}
                {diag.detail && <p className="hint">{diag.detail}</p>}
              </div>
            )}

            <div className="chat">
              <div className="chat-log" ref={logRef}>
                {messages.map((m) => (
                  <div key={m.id} className="chat-turn">
                    <div className={`bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-assistant'}`}>
                      {m.text}
                    </div>
                    {m.role === 'assistant' && (
                      <button
                        type="button"
                        className="btn-ghost btn-sm chat-speak-btn"
                        disabled={configured === false}
                        aria-label={speakingId === m.id ? 'Stop speaking' : 'Speak reply'}
                        onClick={() => void speakText(m.id, m.text)}
                      >
                        {speakingId === m.id ? 'Stop' : 'Speak'}
                      </button>
                    )}
                    {m.actions && m.actions.length > 0 && (
                      <div className="chip-row" style={{ marginTop: '0.35rem' }}>
                        {m.actions.map((a, i) => (
                          <span key={i} className="pill">
                            ✓ {a}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {sending && (
                  <div className="bubble bubble-assistant" aria-live="polite">
                    <span className="muted">{persona.displayName} is thinking…</span>
                  </div>
                )}
              </div>

              <div className="chat-dock">
                <div className="chat-suggestions btn-row">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="chip"
                      onClick={() => void send(s)}
                      disabled={sending || configured === false}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                <form
                  className="chat-composer"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void send(draft)
                  }}
                >
                  <button
                    type="button"
                    className={`btn-secondary btn-sm chat-mic-btn${recording ? ' recording' : ''}`}
                    onClick={() => void toggleMic()}
                    disabled={configured === false || sending || transcribing}
                    aria-pressed={recording}
                    aria-label={recording ? 'Stop recording' : 'Speak a message'}
                    title={recording ? 'Stop recording' : 'Speak a message'}
                  >
                    {transcribing ? '…' : recording ? 'Stop' : 'Mic'}
                  </button>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    rows={2}
                    placeholder={
                      recording
                        ? 'Listening… tap Stop when done'
                        : transcribing
                          ? 'Transcribing…'
                          : `Message ${persona.displayName}…`
                    }
                    aria-label="Message the assistant"
                    disabled={configured === false || recording || transcribing}
                  />
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={!draft.trim() || sending || configured === false || recording || transcribing}
                  >
                    Send
                  </button>
                </form>

                <p className="hint chat-disclaimer">
                  The assistant can log and update your records, but it never diagnoses, prescribes, or
                  changes a dose — and it can only draft messages to your care team, never send them.
                </p>
              </div>
            </div>
          </aside>
        </>
      )}

      <Modal open={pickerOpen} title="Choose a persona" onClose={() => setPickerOpen(false)} wide>
        <p className="hint">The persona sets tone and style only. Your choice is saved for next time.</p>
        <div className="persona-grid">
          {SAMPLE_PERSONAS.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`persona-card ${p.id === persona.id ? 'selected' : ''}`}
              onClick={() => choosePersona(p)}
            >
              <h3>{p.displayName}</h3>
              <p className="muted">{p.tagline}</p>
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
      </Modal>
    </>
  )
}
