import { PageHeader } from '../../../components/PageHeader'
import { Card } from '../../../components/Card'

export function Extract() {
  return (
    <div>
      <PageHeader
        title="Extract"
        description="Stage 2 — per-modality extraction: Whisper transcripts, VLM captions, Apple Vision OCR, InsightFace embeddings."
      />
      <Card>
        <p className="text-sm text-text-muted">
          Not built yet. Wires up after Stage 1 (Ingest) is producing real
          scenes + keyframes.
        </p>
      </Card>
    </div>
  )
}
