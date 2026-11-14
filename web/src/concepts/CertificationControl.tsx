import { useCertification, useRefreshCertification } from '../api/concepts'
import { useUiStore } from '../store/uiStore'
import { certificationLabel } from './certification'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * "Certification: 5 min ago" with a refresh button. The badges read the server's cache; only this button runs the
 * warehouse query, so a stopped warehouse is never woken by opening a tab. Disabled with a reason when no warehouse is selected.
 */
export function CertificationControl() {
  const certification = useCertification()
  const refresh = useRefreshCertification()
  const warehouseId = useUiStore((s) => s.warehouseId)
  const label = certificationLabel(certification.data?.fetched_at, Date.now())
  const noWarehouse = warehouseId === null
  const title = noWarehouse
    ? 'Select a SQL warehouse (Picker, top left) to refresh certification'
    : 'Run one query on the selected warehouse for the system.certification_status tag. This can start a stopped warehouse.'
  return (
    <span className="cert-control" data-testid="cert-control">
      <span className="cert-age" title={certification.data?.fetched_at ?? 'Nothing cached yet'}>
        {label}
      </span>
      <button
        onClick={() => refresh.mutate()}
        disabled={noWarehouse || refresh.isPending}
        title={title}
        aria-label="Refresh certification"
      >
        {refresh.isPending ? '…' : '↻'}
      </button>
      {refresh.isError && (
        <span className="error" role="alert" title={messageOf(refresh.error)}>
          refresh failed
        </span>
      )}
    </span>
  )
}
