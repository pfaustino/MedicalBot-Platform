/**
 * Simple in-memory rate limiter for auth endpoints. Sufficient for a single
 * API instance; swap for Redis-backed limiting if you scale horizontally.
 */
const buckets = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(
  key: string,
  { max, windowMs }: { max: number; windowMs: number },
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now()
  const entry = buckets.get(key)

  if (!entry || now >= entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, retryAfterSec: 0 }
  }

  if (entry.count >= max) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) }
  }

  entry.count += 1
  return { allowed: true, retryAfterSec: 0 }
}
