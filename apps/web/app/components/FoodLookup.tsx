'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { FoodNutrition } from '@medbot/shared'
import { apiGet } from '@/lib/api'

interface SearchHit {
  fdcId: number
  name: string
  brand: string | null
  dataType: string
}

export function FoodLookup({ onSelect }: { onSelect: (food: FoodNutrition) => void }) {
  const listId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      setError(null)
      return
    }

    const handle = window.setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await apiGet<{ results: SearchHit[] }>(
          `/api/food/search?q=${encodeURIComponent(q)}`,
        )
        setResults(data.results)
        setActiveIndex(0)
      } catch {
        setResults([])
        setError('Could not search USDA right now.')
      } finally {
        setLoading(false)
      }
    }, 250)

    return () => window.clearTimeout(handle)
  }, [query, open])

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  async function pick(hit: SearchHit) {
    setPicking(true)
    setError(null)
    try {
      const data = await apiGet<{ food: FoodNutrition }>(`/api/food/${hit.fdcId}`)
      onSelect(data.food)
      setQuery(data.food.name)
      setOpen(false)
    } catch {
      setError('Could not load that food.')
    } finally {
      setPicking(false)
    }
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
      const hit = results[activeIndex]
      if (hit) void pick(hit)
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
        autoComplete="off"
        placeholder="Banana, oatmeal, chicken breast…"
        disabled={picking}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} className="combobox-list" role="listbox">
          {(loading || picking) && <li className="combobox-hint">{picking ? 'Loading nutrients…' : 'Searching…'}</li>}
          {error && <li className="combobox-hint">{error}</li>}
          {!loading && !picking && !error && results.length === 0 && (
            <li className="combobox-hint">
              {query.trim().length < 2
                ? 'Type a food name to search USDA FoodData Central.'
                : 'No matches — try a simpler name, or enter calories yourself.'}
            </li>
          )}
          {!loading &&
            !picking &&
            results.map((hit, index) => (
              <li
                key={hit.fdcId}
                role="option"
                aria-selected={index === activeIndex}
                className={`combobox-option${index === activeIndex ? ' active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  void pick(hit)
                }}
              >
                <span className="combobox-option-label">{hit.name}</span>
                <span className="combobox-option-meta">
                  {hit.brand && <span className="hint">{hit.brand}</span>}
                  <span className="hint">{hit.dataType}</span>
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}
