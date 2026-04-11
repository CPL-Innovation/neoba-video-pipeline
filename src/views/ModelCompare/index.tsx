import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'

export function ModelCompare() {
  return (
    <div>
      <PageHeader
        title="Model Compare"
        description="Side-by-side A/B evaluation of VLM and synthesis backends (Gemma 4 vs. Qwen2.5-VL, etc.) on the same clips."
      />
      <Card>
        <p className="text-sm text-text-muted">
          Not built yet. Will let you pick a clip, run multiple model backends
          against it, and compare caption quality, OCR pickup, throughput, and
          cost.
        </p>
      </Card>
    </div>
  )
}
