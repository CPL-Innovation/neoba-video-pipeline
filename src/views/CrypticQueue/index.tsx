import { useState, useEffect } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import type { ClassifiedItem } from '../../lib/types'

export function CrypticQueue() {
  const [items, setItems] = useState<(ClassifiedItem & { description?: string; date?: string })[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/run/latest/cryptic')
      .then((r) => r.json())
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [])

  const decoded = items.filter((i) => i.decode_note)
  const undecoded = items.filter((i) => !i.decode_note)

  const exportCSV = () => {
    const rows = [
      ['item_id', 'description', 'decode_note', 'date'],
      ...items.map((i) => [i.item_id, i.description || '', i.decode_note || '', i.date || '']),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'cryptic_items.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <PageHeader
        title="Cryptic Queue"
        description="Items flagged as genuinely opaque — station jargon, single-word codes, undecipherable shorthand. For advisor review."
        actions={
          items.length > 0 ? (
            <Button variant="secondary" onClick={exportCSV}>
              Export CSV
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <p className="text-sm text-text-dim">Loading...</p>
      ) : items.length === 0 ? (
        <Card>
          <p className="text-sm text-text-dim">
            No cryptic items yet. Run classification first — items flagged as cryptic will appear here.
          </p>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Partially decoded */}
          {decoded.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-teal mb-3">
                Partially Decoded ({decoded.length})
              </h3>
              <div className="space-y-2">
                {decoded.map((item) => (
                  <Card key={item.item_id}>
                    <div className="flex items-start gap-4">
                      <span className="font-mono text-xs text-text-dim w-16 shrink-0">
                        {item.item_id}
                      </span>
                      <div className="flex-1">
                        <p className="text-sm text-text-primary font-medium">
                          {item.description}
                        </p>
                        <p className="text-xs text-teal mt-1">{item.decode_note}</p>
                      </div>
                      <span className="text-xs text-text-dim">{item.date}</span>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Undecoded */}
          {undecoded.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-coral mb-3">
                Undecoded ({undecoded.length})
              </h3>
              <div className="space-y-2">
                {undecoded.map((item) => (
                  <Card key={item.item_id}>
                    <div className="flex items-start gap-4">
                      <span className="font-mono text-xs text-text-dim w-16 shrink-0">
                        {item.item_id}
                      </span>
                      <p className="text-sm text-text-primary font-medium flex-1">
                        {item.description}
                      </p>
                      <span className="text-xs text-text-dim">{item.date}</span>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
