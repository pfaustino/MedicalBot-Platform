'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAssistant } from '../components/AssistantContext'

/** Bookmarks to /assistant open the floating panel and land on the dashboard. */
export default function AssistantPage() {
  const router = useRouter()
  const { openAssistant } = useAssistant()

  useEffect(() => {
    openAssistant()
    router.replace('/dashboard')
  }, [openAssistant, router])

  return null
}
