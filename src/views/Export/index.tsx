import { useState, useEffect } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'

interface ExportSummary {
  total_items: number
  classified_items: number
  unclassified_items: number
  thread_counts: Record<string, number>
  entity_counts: { people: number; places: number; organizations: number }
  cluster_count: number
  human_overrides: number
  keyword_baseline_agreement: number
}

export function Export() {
  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState(false)

  useEffect(() => {
    fetch('/api/run/latest/export-summary')
      .then((r) => r.json())
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false))
  }, [])

  const handleExport = async () => {
    setExporting(true)
    try {
      await fetch('/api/run/latest/export', { method: 'POST' })
      setExported(true)
    } catch {
      // handle error
    }
    setExporting(false)
  }

  return (
    <div>
      <PageHeader
        title="Export"
        description="Export enriched data for the NEOBA Archive Explorer dashboard."
      />

      {loading ? (
        <p className="text-sm text-text-dim">Loading summary...</p>
      ) : !summary ? (
        <Card>
          <p className="text-sm text-text-dim">
            No classification data available. Complete a classification run first.
          </p>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Summary stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <p className="text-xs text-text-dim uppercase tracking-wider">Total Items</p>
              <p className="text-2xl font-serif text-text-primary mt-1">
                {summary.total_items.toLocaleString()}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-text-dim uppercase tracking-wider">Classified</p>
              <p className="text-2xl font-serif text-teal mt-1">
                {summary.classified_items.toLocaleString()}
              </p>
              <p className="text-xs text-text-dim mt-0.5">
                {((summary.classified_items / summary.total_items) * 100).toFixed(1)}%
              </p>
            </Card>
            <Card>
              <p className="text-xs text-text-dim uppercase tracking-wider">Unclassified</p>
              <p className="text-2xl font-serif text-coral mt-1">
                {summary.unclassified_items.toLocaleString()}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-text-dim uppercase tracking-wider">Human Overrides</p>
              <p className="text-2xl font-serif text-amber mt-1">{summary.human_overrides}</p>
            </Card>
          </div>

          {/* Thread counts */}
          <Card>
            <h3 className="text-sm font-medium text-text-primary mb-3">Thread Distribution</h3>
            <div className="space-y-2">
              {Object.entries(summary.thread_counts)
                .sort(([, a], [, b]) => b - a)
                .map(([thread, count]) => (
                  <div key={thread} className="flex items-center gap-3">
                    <span className="text-xs text-text-muted w-48">{thread}</span>
                    <div className="flex-1 h-1.5 bg-bg3 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-maize"
                        style={{
                          width: `${(count / summary.total_items) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-text-dim font-mono w-16 text-right">
                      {count.toLocaleString()}
                    </span>
                  </div>
                ))}
            </div>
          </Card>

          {/* Export files */}
          <Card>
            <h3 className="text-sm font-medium text-text-primary mb-3">Export Files</h3>
            <div className="space-y-2 text-xs text-text-muted mb-4">
              <p className="font-mono">data/exports/archive-data-enriched.json</p>
              <p className="font-mono">data/exports/items-enriched.json</p>
              <p className="font-mono">data/exports/entity_index.json</p>
              <p className="font-mono">data/exports/clusters.json</p>
              <p className="font-mono">data/exports/cryptic_terms.csv</p>
            </div>

            <Button onClick={handleExport} disabled={exporting} size="lg">
              {exporting ? 'Exporting...' : exported ? 'Exported' : 'Export Enriched Data'}
            </Button>

            {exported && (
              <p className="text-xs text-teal mt-2">
                Files written to data/exports/. Copy to the dashboard repo's public/data/ directory.
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
