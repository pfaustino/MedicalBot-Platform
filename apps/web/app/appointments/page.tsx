'use client'

import { useEffect } from 'react'

/** Appointments moved into Calendar — keep the old URL working. */
export default function AppointmentsRedirect() {
  useEffect(() => {
    window.location.replace('/calendar')
  }, [])

  return (
    <main>
      <p className="hint">Redirecting to Calendar…</p>
    </main>
  )
}
