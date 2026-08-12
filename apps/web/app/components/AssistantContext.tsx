'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

interface AssistantContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  openAssistant: () => void
  closeAssistant: () => void
  toggleAssistant: () => void
}

const AssistantContext = createContext<AssistantContextValue | null>(null)

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  const openAssistant = useCallback(() => setOpen(true), [])
  const closeAssistant = useCallback(() => setOpen(false), [])
  const toggleAssistant = useCallback(() => setOpen((v) => !v), [])

  const value = useMemo(
    () => ({ open, setOpen, openAssistant, closeAssistant, toggleAssistant }),
    [open, openAssistant, closeAssistant, toggleAssistant],
  )

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext)
  if (!ctx) throw new Error('useAssistant must be used within AssistantProvider')
  return ctx
}
