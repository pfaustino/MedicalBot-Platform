'use client'

import { usePathname } from 'next/navigation'

const HIDDEN_ON = new Set(['/', '/terms', '/privacy', '/onboarding', '/admin/login', '/admin/change-password'])

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0'
const SHA = process.env.NEXT_PUBLIC_GIT_SHA ?? 'dev'

/** Small build stamp so we can tell which deploy is live. */
export function BuildFooter() {
  const pathname = usePathname()
  if (HIDDEN_ON.has(pathname)) return null

  return (
    <footer className="build-footer" aria-label="Build version">
      v{VERSION}
      {SHA !== 'dev' ? <span className="build-sha"> · {SHA}</span> : null}
    </footer>
  )
}
