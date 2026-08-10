import Link from 'next/link'

export const dynamic = 'force-static'

export default function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
      <p className="muted">That link does not match anything in MedicalBot.</p>
      <p>
        <Link href="/" className="btn-primary">
          Back to home
        </Link>
      </p>
    </main>
  )
}
