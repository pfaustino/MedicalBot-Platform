import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const apiProxy = process.env.API_PROXY_URL ?? 'http://localhost:3001'
const isProdBuild = process.env.NODE_ENV === 'production'

const rootPkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
)
const gitSha = (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_GIT_SHA ?? 'dev').slice(
  0,
  7,
)

const nextConfig = {
  reactStrictMode: true,
  /**
   * Static export for production (served by the API on one origin). Omitted during
   * `next dev` so rewrites can proxy API calls to :3001 on the same origin.
   */
  ...(isProdBuild ? { output: 'export' } : {}),
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? '',
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? String(rootPkg.version ?? '0.0.0'),
    NEXT_PUBLIC_GIT_SHA: gitSha,
  },
  async rewrites() {
    return [
      { source: '/health', destination: `${apiProxy}/health` },
      { source: '/legal', destination: `${apiProxy}/legal` },
      { source: '/auth/:path*', destination: `${apiProxy}/auth/:path*` },
      { source: '/api/:path*', destination: `${apiProxy}/api/:path*` },
    ]
  },
}

export default nextConfig
