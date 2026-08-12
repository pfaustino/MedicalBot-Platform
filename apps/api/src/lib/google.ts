import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db, schema } from '../db/index.js'
import { decrypt, encrypt } from './crypto.js'

const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'

export function hasCalendarScope(scopes: string[] | null | undefined): boolean {
  if (!scopes?.length) return false
  return scopes.some(
    (s) =>
      s === CALENDAR_EVENTS_SCOPE ||
      s === 'https://www.googleapis.com/auth/calendar' ||
      s.includes('calendar.events'),
  )
}

/** Merge scope lists, dropping empties and duplicates. */
export function mergeScopes(...lists: (string[] | string | null | undefined)[]): string[] {
  const out = new Set<string>()
  for (const list of lists) {
    const parts = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/\s+/) : []
    for (const p of parts) {
      const s = p.trim()
      if (s) out.add(s)
    }
  }
  return [...out]
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string
  expires_in: number
  scope?: string
}> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID!,
      client_secret: config.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    throw new Error(`Google token refresh failed (${res.status})`)
  }
  return (await res.json()) as { access_token: string; expires_in: number; scope?: string }
}

/**
 * Returns a usable Google access token for the user, refreshing if needed.
 * Returns null when the account has no stored Google tokens.
 */
export async function getGoogleAccessToken(userId: string): Promise<{
  accessToken: string
  scopes: string[]
} | null> {
  const [row] = await db
    .select()
    .from(schema.googleAccounts)
    .where(eq(schema.googleAccounts.userId, userId))
    .limit(1)

  if (!row) return null

  const scopes = row.scopes ?? []
  const stillValid = row.expiresAt.getTime() > Date.now() + 60_000
  if (stillValid) {
    return { accessToken: row.accessToken, scopes }
  }

  if (!row.refreshTokenEncrypted) {
    return null
  }

  const refreshed = await refreshAccessToken(decrypt(row.refreshTokenEncrypted))
  const nextScopes = refreshed.scope ? mergeScopes(scopes, refreshed.scope) : scopes
  await db
    .update(schema.googleAccounts)
    .set({
      accessToken: refreshed.access_token,
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
      scopes: nextScopes,
      updatedAt: new Date(),
    })
    .where(eq(schema.googleAccounts.userId, userId))

  return { accessToken: refreshed.access_token, scopes: nextScopes }
}

export async function getCalendarConnection(userId: string): Promise<{
  connected: boolean
  scopes: string[]
}> {
  const token = await getGoogleAccessToken(userId)
  if (!token) return { connected: false, scopes: [] }
  return { connected: hasCalendarScope(token.scopes), scopes: token.scopes }
}

export type GoogleCalendarEvent = {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  location: string | null
  htmlLink: string | null
}

async function googleErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } }
    return body.error?.message ?? body.error?.status ?? res.statusText
  } catch {
    return res.statusText || `HTTP ${res.status}`
  }
}

function mapCalendarListError(status: number, detail: string): Error {
  const lower = detail.toLowerCase()
  if (status === 401 || lower.includes('invalid credentials') || lower.includes('auth')) {
    return new Error('Google session expired. Disconnect isn’t needed — click Connect Google Calendar again.')
  }
  if (
    status === 403 &&
    (lower.includes('has not been used') ||
      lower.includes('disabled') ||
      lower.includes('access not configured') ||
      lower.includes('calendar api'))
  ) {
    return new Error(
      'Google Calendar API is not enabled on your Google Cloud project. In Google Cloud Console → APIs & Services → Library, enable “Google Calendar API”, then reload.',
    )
  }
  if (status === 403) {
    return new Error(
      'Google denied Calendar access. Reconnect Google Calendar and make sure the calendar.events scope is granted.',
    )
  }
  return new Error(`Google Calendar list failed (${status}): ${detail}`)
}

/** List primary-calendar events in [timeMin, timeMax). */
export async function listGoogleCalendarEvents(
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<GoogleCalendarEvent[]> {
  let token = await getGoogleAccessToken(userId)
  if (!token || !hasCalendarScope(token.scopes)) return []

  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  })
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`

  async function fetchList(accessToken: string): Promise<Response> {
    return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  }

  let res = await fetchList(token.accessToken)

  // Access token may be stale even if expiresAt says otherwise — refresh once.
  if (res.status === 401) {
    const [row] = await db
      .select({ refreshTokenEncrypted: schema.googleAccounts.refreshTokenEncrypted })
      .from(schema.googleAccounts)
      .where(eq(schema.googleAccounts.userId, userId))
      .limit(1)
    if (row?.refreshTokenEncrypted) {
      const refreshed = await refreshAccessToken(decrypt(row.refreshTokenEncrypted))
      await db
        .update(schema.googleAccounts)
        .set({
          accessToken: refreshed.access_token,
          expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
          ...(refreshed.scope ? { scopes: mergeScopes(token.scopes, refreshed.scope) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.googleAccounts.userId, userId))
      token = {
        accessToken: refreshed.access_token,
        scopes: refreshed.scope ? mergeScopes(token.scopes, refreshed.scope) : token.scopes,
      }
      res = await fetchList(token.accessToken)
    }
  }

  if (!res.ok) {
    throw mapCalendarListError(res.status, await googleErrorDetail(res))
  }

  const data = (await res.json()) as {
    items?: Array<{
      id?: string
      summary?: string
      location?: string
      htmlLink?: string
      start?: { dateTime?: string; date?: string }
      end?: { dateTime?: string; date?: string }
    }>
  }

  return (data.items ?? [])
    .filter((e) => e.id)
    .map((e) => {
      const allDay = Boolean(e.start?.date && !e.start?.dateTime)
      const startsAt = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00.000Z` : '')
      const endsAt = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00.000Z` : null)
      return {
        id: e.id!,
        title: e.summary?.trim() || '(No title)',
        startsAt,
        endsAt,
        allDay,
        location: e.location ?? null,
        htmlLink: e.htmlLink ?? null,
      }
    })
    .filter((e) => e.startsAt)
}

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function googleEventTimes(event: {
  startsAt: Date
  endsAt?: Date | null
  allDay?: boolean
}): { start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string } } {
  if (event.allDay) {
    const startDay = new Date(event.startsAt.getFullYear(), event.startsAt.getMonth(), event.startsAt.getDate())
    const endExclusive = event.endsAt
      ? new Date(event.endsAt.getFullYear(), event.endsAt.getMonth(), event.endsAt.getDate())
      : new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + 1)
    if (+endExclusive <= +startDay) {
      endExclusive.setDate(endExclusive.getDate() + 1)
    }
    return { start: { date: ymdLocal(startDay) }, end: { date: ymdLocal(endExclusive) } }
  }
  const endAt = event.endsAt ?? new Date(event.startsAt.getTime() + 60 * 60 * 1000)
  return {
    start: { dateTime: event.startsAt.toISOString() },
    end: { dateTime: endAt.toISOString() },
  }
}

export async function createGoogleCalendarEvent(
  userId: string,
  event: {
    title: string
    startsAt: Date
    endsAt?: Date | null
    location?: string | null
    description?: string | null
    allDay?: boolean
  },
): Promise<string | null> {
  const token = await getGoogleAccessToken(userId)
  if (!token || !hasCalendarScope(token.scopes)) return null

  const { start, end } = googleEventTimes(event)

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary: event.title,
      location: event.location ?? undefined,
      description: event.description ?? undefined,
      start,
      end,
    }),
  })

  if (!res.ok) {
    throw new Error(`Google Calendar create failed (${res.status})`)
  }

  const created = (await res.json()) as { id?: string }
  return created.id ?? null
}

export async function updateGoogleCalendarEvent(
  userId: string,
  eventId: string,
  event: {
    title: string
    startsAt: Date
    endsAt?: Date | null
    location?: string | null
    description?: string | null
    allDay?: boolean
  },
): Promise<void> {
  const token = await getGoogleAccessToken(userId)
  if (!token || !hasCalendarScope(token.scopes)) {
    throw new Error('Google Calendar is not connected')
  }

  const { start, end } = googleEventTimes(event)
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: event.title,
        location: event.location ?? undefined,
        description: event.description ?? undefined,
        start,
        end,
      }),
    },
  )

  if (!res.ok) {
    throw new Error(`Google Calendar update failed (${res.status})`)
  }
}

export async function deleteGoogleCalendarEvent(userId: string, eventId: string): Promise<void> {
  const token = await getGoogleAccessToken(userId)
  if (!token || !hasCalendarScope(token.scopes)) {
    throw new Error('Google Calendar is not connected')
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token.accessToken}` },
    },
  )

  // 404/410 = already gone — treat as success
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar delete failed (${res.status})`)
  }
}

/** Persist tokens after an OAuth exchange (login or incremental connect). */
export async function upsertGoogleAccount(
  userId: string,
  tokens: { access_token: string; refresh_token?: string; expires_in: number; scope: string },
): Promise<void> {
  const [existing] = await db
    .select({
      refreshTokenEncrypted: schema.googleAccounts.refreshTokenEncrypted,
      scopes: schema.googleAccounts.scopes,
    })
    .from(schema.googleAccounts)
    .where(eq(schema.googleAccounts.userId, userId))
    .limit(1)

  const scopes = mergeScopes(existing?.scopes, tokens.scope)
  const refreshTokenEncrypted = tokens.refresh_token
    ? encrypt(tokens.refresh_token)
    : (existing?.refreshTokenEncrypted ?? null)

  await db
    .insert(schema.googleAccounts)
    .values({
      userId,
      accessToken: tokens.access_token,
      refreshTokenEncrypted,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      scopes,
    })
    .onConflictDoUpdate({
      target: schema.googleAccounts.userId,
      set: {
        accessToken: tokens.access_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scopes,
        ...(tokens.refresh_token ? { refreshTokenEncrypted: encrypt(tokens.refresh_token) } : {}),
        updatedAt: new Date(),
      },
    })
}
