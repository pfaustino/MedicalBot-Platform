'use client'

import { useEffect, useState } from 'react'
import { apiGet, NotAuthenticated } from '@/lib/api'

export interface Me {
  id: string
  email: string
  role: 'user' | 'admin' | 'owner'
  isAdmin: boolean
  mustChangePassword: boolean
  hasPassword: boolean
  needsTermsAcceptance: boolean
  onboardedAt: string | null
  avatarUrl: string | null
  displayName: string | null
}

type MeState =
  | { status: 'loading' }
  | { status: 'anon' }
  | { status: 'signed-in'; me: Me }

/** Shared session read. Every gated page needs the same three states. */
export function useMe(): MeState {
  const [state, setState] = useState<MeState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    apiGet<Me>('/auth/me')
      .then((me) => {
        if (!cancelled) setState({ status: 'signed-in', me })
      })
      .catch((e) => {
        if (cancelled) return
        if (e instanceof NotAuthenticated) setState({ status: 'anon' })
        else setState({ status: 'anon' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
