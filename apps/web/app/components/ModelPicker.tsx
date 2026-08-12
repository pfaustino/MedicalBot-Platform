'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { apiGet } from '@/lib/api'

interface ModelResult {
  id: string
  name: string
  contextLength?: number
}

export type ModelKind = 'text' | 'speech' | 'transcription'

interface ModelPickerProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  disabled?: boolean
  /** When false, the input still accepts custom ids but does not fetch the model list. */
  modelsAvailable?: boolean
  hint?: string
  kind?: ModelKind
}

export function ModelPicker({
  value,
  onChange,
  label,
  placeholder = 'Search models…',
  disabled,
  modelsAvailable = true,
  hint,
  kind = 'text',
}: ModelPickerProps) {
  const listId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModelResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !modelsAvailable) return

    const handle = window.setTimeout(async () => {
      setLoading(true)
      setFetchError(null)
      try {
        const params = new URLSearchParams({ q: query, kind })
        const data = await apiGet<{ models: ModelResult[] }>(`/api/settings/ai/models?${params}`)
        setResults(data.models)
        setActiveIndex(0)
      } catch {
        setResults([])
        setFetchError('Could not load models.')
      } finally {
        setLoading(false)
      }
    }, 200)

    return () => window.clearTimeout(handle)
  }, [query, open, modelsAvailable, kind])

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  function pick(result: ModelResult) {
    onChange(result.id)
    setQuery('')
    setOpen(false)
  }

  function toggleOpen() {
    if (disabled) return
    setOpen((was) => {
      const next = !was
      if (!next) setQuery('')
      return next
    })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return

    if (results.length === 0) {
      if (e.key === 'Escape') {
        setOpen(false)
        setQuery('')
      }
      if (e.key === 'Enter' && query.trim()) {
        e.preventDefault()
        onChange(query.trim())
        setQuery('')
        setOpen(false)
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(results[activeIndex]!)
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  const display = open ? query : value
  const showCustomHint =
    !loading && open && query.trim().length > 0 && !results.some((m) => m.id === query.trim())

  return (
    <label className="field">
      {label && <span>{label}</span>}
      <div className="combobox" ref={wrapRef}>
        <div className="combobox-trigger">
          <input
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            value={display}
            placeholder={placeholder}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value
              setQuery(next)
              setOpen(true)
            }}
            onFocus={() => {
              if (modelsAvailable && !disabled) {
                setQuery('')
                setOpen(true)
              }
            }}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="combobox-chevron"
            tabIndex={-1}
            aria-label={open ? 'Close model list' : 'Open model list'}
            disabled={disabled || !modelsAvailable}
            onClick={toggleOpen}
          >
            ▾
          </button>
        </div>

        {open && modelsAvailable && !disabled && (
          <ul id={listId} className="combobox-list" role="listbox">
            {loading && <li className="combobox-hint">Loading models…</li>}
            {!loading && fetchError && <li className="combobox-hint">{fetchError}</li>}
            {!loading && !fetchError && results.length === 0 && (
              <li className="combobox-hint">
                {query.trim().length === 0
                  ? 'No models returned.'
                  : 'No matches — press Enter to save this as a custom model id.'}
              </li>
            )}
            {!loading &&
              results.map((result, index) => (
                <li
                  key={result.id}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`combobox-option${index === activeIndex ? ' active' : ''}${result.id === value ? ' selected' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(result)
                  }}
                >
                  <span className="combobox-option-label">{result.id}</span>
                  <span className="combobox-option-meta">
                    {result.name !== result.id && <span className="hint">{result.name}</span>}
                    {result.contextLength != null && (
                      <span className="hint">{result.contextLength.toLocaleString()} ctx</span>
                    )}
                  </span>
                </li>
              ))}
            {showCustomHint && !fetchError && (
              <li className="combobox-hint">Press Enter to use “{query.trim()}” as a custom model.</li>
            )}
          </ul>
        )}
      </div>
      {hint && <p className="help-text">{hint}</p>}
    </label>
  )
}
