import { useState, useEffect } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import type { ProposedThread } from '../../lib/types'

export function ProposedThreads() {
  const [threads, setThreads] = useState<ProposedThread[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/run/latest/proposed-threads')
      .then((r) => r.json())
      .then(setThreads)
      .catch(() => setThreads([]))
      .finally(() => setLoading(false))
  }, [])

  const handleAction = async (name: string, action: 'accept' | 'reject' | 'merge', mergeInto?: string) => {
    await fetch('/api/run/latest/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'proposed_thread', name, action, merge_into: mergeInto }),
    })
    setThreads((prev) =>
      prev.map((t) =>
        t.name === name
          ? { ...t, status: action === 'merge' ? 'merged' : action === 'accept' ? 'accepted' : 'rejected', merged_into: mergeInto }
          : t
      )
    )
  }

  return (
    <div>
      <PageHeader
        title="Proposed Threads"
        description="Review LLM-suggested thread names that didn't fit the 11 defined threads. Accept, reject, or merge."
      />

      {loading ? (
        <p className="text-sm text-text-dim">Loading...</p>
      ) : threads.length === 0 ? (
        <Card>
          <p className="text-sm text-text-dim">
            No proposed threads yet. Run a classification first, then proposed threads will appear here.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {threads
            .sort((a, b) => b.count - a.count)
            .map((t) => (
              <Card key={t.name}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-medium text-text-primary">{t.name}</h3>
                      <span className="text-xs text-text-dim font-mono">{t.count} items</span>
                      {t.status !== 'pending' && (
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            t.status === 'accepted'
                              ? 'bg-teal/20 text-teal'
                              : t.status === 'rejected'
                                ? 'bg-coral/20 text-coral'
                                : 'bg-purple/20 text-purple'
                          }`}
                        >
                          {t.status}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 space-y-1">
                      {t.sample_descriptions.slice(0, 3).map((d, i) => (
                        <p key={i} className="text-xs text-text-muted font-mono">
                          {d}
                        </p>
                      ))}
                    </div>
                    {t.similar_proposals.length > 0 && (
                      <p className="text-xs text-text-dim mt-2">
                        Similar: {t.similar_proposals.join(', ')}
                      </p>
                    )}
                  </div>

                  {t.status === 'pending' && (
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" onClick={() => handleAction(t.name, 'accept')}>
                        Accept
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleAction(t.name, 'reject')}>
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
        </div>
      )}
    </div>
  )
}
