/**
 * Empty by default: the API serves this app, so requests are same-origin and
 * relative. Only set NEXT_PUBLIC_API_URL if the API lives elsewhere.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

export async function apiFetch(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  // Only advertise a JSON body when we actually send one. A POST that declares
  // application/json with an empty body is rejected with 400 by the server —
  // that was silently breaking Terms acceptance and logout.
  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  })
}

export class NotAuthenticated extends Error {
  constructor() {
    super('Not authenticated')
    this.name = 'NotAuthenticated'
  }
}

/** GET returning parsed JSON. Throws NotAuthenticated on 401 so pages can
 *  redirect to sign-in instead of rendering an empty shell. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  if (res.status === 401) throw new NotAuthenticated()
  if (!res.ok) throw new ApiError(path, res.status, await safeBody(res))
  return (await res.json()) as T
}

export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
  if (res.status === 401) throw new NotAuthenticated()
  if (!res.ok) throw new ApiError(path, res.status, await safeBody(res))
  return (await res.json()) as T
}

/** POST that returns a binary body (e.g. assistant TTS audio/mpeg). */
export async function apiPostBlob(path: string, body: unknown = {}): Promise<Blob> {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
  if (res.status === 401) throw new NotAuthenticated()
  if (!res.ok) throw new ApiError(path, res.status, await safeBody(res))
  return res.blob()
}

export async function apiPatch<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) })
  if (res.status === 401) throw new NotAuthenticated()
  if (!res.ok) throw new ApiError(path, res.status, await safeBody(res))
  return (await res.json()) as T
}

export async function apiPut<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await apiFetch(path, { method: 'PUT', body: JSON.stringify(body) })
  if (res.status === 401) throw new NotAuthenticated()
  if (!res.ok) throw new ApiError(path, res.status, await safeBody(res))
  return (await res.json()) as T
}

/**
 * Fastify rejects an empty body sent with a JSON content-type, so a bodyless
 * DELETE has to carry an empty object.
 */
export async function apiDelete<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: 'DELETE', body: '{}' })
  if (res.status === 401) throw new NotAuthenticated()
  if (!res.ok) throw new ApiError(path, res.status, await safeBody(res))
  return (await res.json()) as T
}

export class ApiError extends Error {
  constructor(
    public path: string,
    public status: number,
    public body: unknown,
  ) {
    super(`${path} failed: ${status}`)
    this.name = 'ApiError'
  }
}

/** Extract a server `error` string from an ApiError body, if present. */
export function apiErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const msg = (body as { error?: unknown }).error
    return typeof msg === 'string' && msg.trim() ? msg : null
  }
  return null
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}
