import { PageHeader } from '../../../components/PageHeader'
import { Card } from '../../../components/Card'

export function VideoCluster() {
  return (
    <div>
      <PageHeader
        title="Cluster"
        description="Stage 3 — face embedding clustering (DBSCAN) and scene/transcript alignment into per-scene fact bundles."
      />
      <Card>
        <p className="text-sm text-text-muted">
          Not built yet. Depends on Stage 2 (Extract) producing face embeddings
          and transcript segments.
        </p>
      </Card>
    </div>
  )
}
