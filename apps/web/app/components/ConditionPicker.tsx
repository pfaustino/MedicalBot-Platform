'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { apiGet } from '@/lib/api'

export interface ConditionSelection {
  name: string
  moduleKey: string | null
  icdCode: string | null
}

interface SearchResult {
  key: string
  name: string
  icdCode: string | null
  moduleKey: string | null
  hasModule: boolean
  source: 'module' | 'icd' | 'custom'
}

interface ConditionPickerProps {
  value: ConditionSelection | null
  onChange: (value: ConditionSelection) => void
  error?: string | null
  autoFocus?: boolean
}

export function ConditionPicker({ value, onChange, error, autoFocus }: ConditionPickerProps) {
  const listId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState(value?.name ?? '')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!open) return

    const handle = window.setTimeout(async () => {
      setLoading(true)
      try {
        const data = await apiGet<{ results: SearchResult[] }>(
          `/api/conditions/search?q=${encodeURIComponent(query)}`,
        )
        setResults(data.results)
        setActiveIndex(0)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 200)

    return () => window.clearTimeout(handle)
  }, [query, open])

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  function pick(result: SearchResult) {
    onChange({
      name: result.name,
      moduleKey: result.moduleKey,
      icdCode: result.icdCode,
    })
    setQuery(result.name)
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true)
      return
    }
    if (!open || results.length === 0) return

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
    }
  }

  return (
    <div className="combobox" ref={wrapRef}>
      <input
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        autoFocus={autoFocus}
        placeholder="Search by name or ICD-10 code…"
        autoComplete="off"
        className={error ? 'field-error-input' : undefined}
        onChange={(e) => {
          const name = e.target.value
          setQuery(name)
          setOpen(true)
          onChange({ name, moduleKey: null, icdCode: null })
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open && (
        <ul id={listId} className="combobox-list" role="listbox">
          {loading && <li className="combobox-hint">Searching…</li>}
          {!loading && results.length === 0 && (
            <li className="combobox-hint">
              {query.trim().length < 2
                ? 'Type at least 2 characters to search, or pick from the list.'
                : 'No matches — press Enter to add as a custom condition.'}
            </li>
          )}
          {!loading &&
            results.map((result, index) => (
              <li
                key={result.key}
                role="option"
                aria-selected={index === activeIndex}
                className={`combobox-option${index === activeIndex ? ' active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(result)
                }}
              >
                <span className="combobox-option-label">{result.name}</span>
                <span className="combobox-option-meta">
                  {result.icdCode && <span className="hint">{result.icdCode}</span>}
                  {result.hasModule && <span className="badge">Tracks metrics</span>}
                  {result.source === 'custom' && <span className="hint">Add custom</span>}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}
