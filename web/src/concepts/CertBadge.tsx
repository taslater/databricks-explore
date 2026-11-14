import type { CertificationStatus } from '../api/concepts'

/** A small "certified" or "deprecated" pill, from the `system.certification_status` tag. */
export function CertBadge({ status }: { status: CertificationStatus | undefined }) {
  if (!status) return null
  return (
    <span className={`cert-badge cert-${status}`} title={`Tagged system.certification_status = ${status}`} data-testid="cert-badge">
      {status}
    </span>
  )
}
