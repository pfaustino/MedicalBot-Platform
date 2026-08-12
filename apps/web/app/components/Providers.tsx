'use client'

import type { ReactNode } from 'react'
import { AssistantProvider } from './AssistantContext'
import { AssistantShell } from './AssistantShell'
import { ToastProvider } from './Toast'

/** Client-side context providers mounted once at the root. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AssistantProvider>
        {children}
        <AssistantShell />
      </AssistantProvider>
    </ToastProvider>
  )
}
