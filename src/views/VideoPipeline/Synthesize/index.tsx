import { PageHeader } from '../../../components/PageHeader'
import { Card } from '../../../components/Card'

export function Synthesize() {
  return (
    <div>
      <PageHeader
        title="Synthesize"
        description="Stage 4 — local LLM synthesis (Gemma 4 26B A4B) into Dublin-Core-compatible JSON with schema-constrained output."
      />
      <Card>
        <p className="text-sm text-text-muted">
          Not built yet. Reads per-scene fact bundles from Stage 3 and emits
          structured metadata.
        </p>
      </Card>
    </div>
  )
}
