import { useState, useEffect } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'
import type { ProposedThread } from '../../lib/types'
import { THREADS } from '../../lib/constants'

export function ProposedThreads() {
  const [threads, setThreads] = useState<ProposedThread[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())
  const [mergeMode, setMergeMode] = useState(false)
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set())
  const [canonicalName, setCanonicalName] = useState('')
  const [remapOpen, setRemapOpen] = useState<string | null>(null)

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
    if (action === 'accept' || action === 'reject') {
      // Accept/reject genuinely removes the thread from the list
      setThreads((prev) => prev.filter((t) => t.name !== name))
    } else {
      setThreads((prev) =>
        prev.map((t) =>
          t.name === name
            ? { ...t, status: 'merged', merged_into: mergeInto }
            : t
        )
      )
    }
  }

  const handleRemap = async (proposedName: string, targetThread: string) => {
    await fetch('/api/run/latest/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'proposed_thread', name: proposedName, action: 'remap', merge_into: targetThread }),
    })
    setThreads((prev) => prev.filter((t) => t.name !== proposedName))
    setRemapOpen(null)
  }

  const toggleSelection = (name: string) => {
    setSelectedForMerge((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleMergeConfirm = async () => {
    const name = canonicalName.trim()
    if (!name || selectedForMerge.size < 2) return

    // Post merge edits to backend
    for (const threadName of selectedForMerge) {
      if (threadName !== name) {
        await fetch('/api/run/latest/edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'proposed_thread', name: threadName, action: 'merge', merge_into: name }),
        })
      }
    }

    // Consolidate in the UI: combine counts and descriptions into one pending thread
    setThreads((prev) => {
      const mergedNames = new Set(selectedForMerge)
      const mergedThreads = prev.filter((t) => mergedNames.has(t.name))
      const remainingThreads = prev.filter((t) => !mergedNames.has(t.name))

      const combinedCount = mergedThreads.reduce((sum, t) => sum + t.count, 0)
      const combinedDescriptions = mergedThreads.flatMap((t) => t.sample_descriptions)
      const combinedSimilar = mergedThreads
        .flatMap((t) => [t.name, ...t.similar_proposals])
        .filter((n) => n !== name)
        .filter((v, i, arr) => arr.indexOf(v) === i)

      const consolidated: ProposedThread = {
        name,
        count: combinedCount,
        sample_descriptions: combinedDescriptions,
        similar_proposals: combinedSimilar,
        status: 'pending',
        merged_into: undefined,
      }

      return [...remainingThreads, consolidated]
    })

    setMergeMode(false)
    setSelectedForMerge(new Set())
    setCanonicalName('')
  }

  const exitMergeMode = () => {
    setMergeMode(false)
    setSelectedForMerge(new Set())
    setCanonicalName('')
  }

  // Set canonical name to first selected thread when selection changes
  useEffect(() => {
    if (selectedForMerge.size > 0 && !canonicalName) {
      setCanonicalName([...selectedForMerge][0])
    }
  }, [selectedForMerge, canonicalName])

  const pendingThreads = threads.filter((t) => t.status === 'pending')

  return (
    <div className="relative pb-20">
      <div className="flex items-center justify-between mb-4">
        <PageHeader
          title="Proposed Threads"
          description="Review LLM-suggested thread names that didn't fit the 11 defined threads. Accept, reject, or merge."
        />
        {!mergeMode && pendingThreads.length >= 2 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setMergeMode(true)}
          >
            Merge Threads
          </Button>
        )}
        {mergeMode && (
          <Button size="sm" variant="ghost" onClick={exitMergeMode}>
            Cancel Merge
          </Button>
        )}
      </div>

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
              <Card
                key={t.name}
                className={
                  mergeMode && selectedForMerge.has(t.name)
                    ? 'ring-1 ring-purple'
                    : ''
                }
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    {mergeMode && t.status === 'pending' && (
                      <input
                        type="checkbox"
                        checked={selectedForMerge.has(t.name)}
                        onChange={() => toggleSelection(t.name)}
                        className="mt-1 rounded"
                      />
                    )}
                    <div>
                      <div className="flex items-center gap-3">
                        <h3 className="text-sm font-medium text-text-primary">{t.name}</h3>
                        <span className="text-xs text-text-dim font-mono">{t.count} items</span>
                        {t.status !== 'pending' && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              t.status === 'accepted' || t.status === 'accept'
                                ? 'bg-teal/20 text-teal'
                                : t.status === 'rejected' || t.status === 'reject'
                                  ? 'bg-coral/20 text-coral'
                                  : 'bg-purple/20 text-purple'
                            }`}
                          >
                            {t.status === 'accept' ? 'accepted' : t.status === 'reject' ? 'rejected' : t.status}
                            {(t.status === 'merged' || t.status === 'merge') && t.merged_into ? ` into "${t.merged_into}"` : ''}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 space-y-1">
                        {(expandedThreads.has(t.name)
                          ? t.sample_descriptions
                          : t.sample_descriptions.slice(0, 3)
                        ).map((d, i) => (
                          <p key={i} className="text-xs text-text-muted font-mono">
                            {d}
                          </p>
                        ))}
                        {t.sample_descriptions.length > 3 && (
                          <button
                            className="text-xs text-teal hover:text-teal/80 mt-1"
                            onClick={(e) => {
                              e.stopPropagation()
                              setExpandedThreads((prev) => {
                                const next = new Set(prev)
                                if (next.has(t.name)) next.delete(t.name)
                                else next.add(t.name)
                                return next
                              })
                            }}
                          >
                            {expandedThreads.has(t.name)
                              ? 'Show less'
                              : `Show all ${t.count} items`}
                          </button>
                        )}
                      </div>
                      {t.similar_proposals.length > 0 && (
                        <p className="text-xs text-text-dim mt-2">
                          Similar: {t.similar_proposals.join(', ')}
                        </p>
                      )}
                    </div>
                  </div>

                  {!mergeMode && t.status === 'pending' && (
                    <div className="flex gap-2 shrink-0 relative">
                      <Button size="sm" onClick={() => handleAction(t.name, 'accept')}>
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setRemapOpen(remapOpen === t.name ? null : t.name)}
                      >
                        Remap
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleAction(t.name, 'reject')}>
                        Reject
                      </Button>
                      {remapOpen === t.name && (
                        <div className="absolute top-full right-0 mt-1 bg-bg2 border border-white/10 rounded-lg shadow-lg z-20 py-1 w-56">
                          <p className="px-3 py-1.5 text-xs text-text-dim">Remap to:</p>
                          {THREADS.map((thread) => (
                            <button
                              key={thread}
                              className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-white/5 transition-colors"
                              onClick={() => handleRemap(t.name, thread)}
                            >
                              {thread}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            ))}
        </div>
      )}

      {/* Merge bar */}
      {mergeMode && selectedForMerge.size >= 2 && (
        <div className="fixed bottom-0 left-0 right-0 bg-bg2 border-t border-white/10 px-6 py-4 z-50">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-text-dim mb-2">
                Merging {selectedForMerge.size} threads: {[...selectedForMerge].join(', ')}
              </p>
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-muted whitespace-nowrap">Canonical name:</label>
                <input
                  type="text"
                  value={canonicalName}
                  onChange={(e) => setCanonicalName(e.target.value)}
                  className="flex-1 bg-bg3 border border-white/10 rounded-md px-3 py-1.5 text-sm text-text-primary"
                />
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="ghost" onClick={exitMergeMode}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!canonicalName.trim()}
                onClick={handleMergeConfirm}
              >
                Merge
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
