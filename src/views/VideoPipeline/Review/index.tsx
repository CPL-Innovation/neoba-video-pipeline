import { PageHeader } from '../../../components/PageHeader'
import { Card } from '../../../components/Card'

export function VideoReview() {
  return (
    <div>
      <PageHeader
        title="Review"
        description="Stage 5 — human-in-the-loop review of synthesized video metadata, with confidence-flagged fields for SME validation."
      />
      <Card>
        <p className="text-sm text-text-muted">
          Not built yet. Reads from data/runs/video/&lt;video_id&gt;/ and lets
          you accept, edit, or flag fields before export.
        </p>
      </Card>
    </div>
  )
}
