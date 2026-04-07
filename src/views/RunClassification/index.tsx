import { useState, useEffect, useRef } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import { Button } from '../../components/Button'

type Status = 'idle' | 'classifying' | 'stopping' | 'stopped' | 'clustering' | 'done'

export function RunClassification() {
  const [model, setModel] = useState('claude-haiku-4-5-20251001')
  const [batchSize, setBatchSize] = useState(50)
  const [includeNotes, setIncludeNotes] = useState(true)
  const [runName, setRunName] = useState(() => new Date().toISOString().slice(0, 10))
  const [isRunning, setIsRunning] = useState(false)
  const [progress, setProgress] = useState({ completed: 0, total: 0, errors: 0, errorMessages: [] as { batch: number; error: string }[], classifiedItems: 0, totalItems: 0, unclassified: 0 })
  const [showErrors, setShowErrors] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // On mount, check if there's already a running or stopped job
  useEffect(() => {
    async function checkExistingRun() {
      try {
        const res = await fetch(`/api/run/${runName}/status`)
        if (!res.ok) return
        const data = await res.json()
        if (data.status === 'running' || data.status === 'stopping') {
          setIsRunning(data.status === 'running')
          setStatus(data.status === 'stopping' ? 'stopping' : 'classifying')
          setProgress({ completed: data.batches_completed, total: data.batches_total, errors: data.errors, errorMessages: data.error_messages || [], classifiedItems: data.classified_items || 0, totalItems: data.total_items || 0, unclassified: data.unclassified || 0 })
          startPolling(runName)
        } else if (data.status === 'stopped') {
          setStatus('stopped')
          setProgress({ completed: data.batches_completed || 0, total: data.batches_total || 0, errors: data.errors || 0, errorMessages: data.error_messages || [], classifiedItems: data.classified_items || 0, totalItems: data.total_items || 0, unclassified: data.unclassified || 0 })
        } else if (data.status === 'completed' || data.status === 'completed_with_errors') {
          setStatus('done')
          setProgress({ completed: data.batches_completed || data.batches_total, total: data.batches_total, errors: data.errors, errorMessages: data.error_messages || [], classifiedItems: data.classified_items || 0, totalItems: data.total_items || 0, unclassified: data.unclassified || 0 })
        }
      } catch { /* no existing run */ }
    }
    checkExistingRun()

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function startPolling(runId: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const statusRes = await fetch(`/api/run/${runId}/status`)
        const data = await statusRes.json()
        setProgress({ completed: data.batches_completed, total: data.batches_total, errors: data.errors, errorMessages: data.error_messages || [], classifiedItems: data.classified_items || 0, totalItems: data.total_items || 0, unclassified: data.unclassified || 0 })

        if (data.status === 'stopping') {
          setStatus('stopping')
        } else if (data.status === 'stopped') {
          if (pollRef.current) clearInterval(pollRef.current)
          setIsRunning(false)
          setStatus('stopped')
        } else if (data.status === 'completed' || data.status === 'failed' || data.status === 'completed_with_errors') {
          if (pollRef.current) clearInterval(pollRef.current)
          setIsRunning(false)
          setStatus(data.status === 'failed' ? 'idle' : 'done')
        }
      } catch { /* poll error, keep trying */ }
    }, 2000)
  }

  const startClassification = async () => {
    setIsRunning(true)
    setStatus('classifying')
    // Don't reset progress — if resuming, we want to see existing progress update
    try {
      const res = await fetch('/api/run/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, batch_size: batchSize, include_notes: includeNotes, run_name: runName }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }))
        throw new Error(err.detail || 'Failed to start')
      }
      const { run_id } = await res.json()
      startPolling(run_id)
    } catch (e) {
      setIsRunning(false)
      setStatus('idle')
      console.error('Classification error:', e)
    }
  }

  const stopClassification = async () => {
    setStatus('stopping')
    try {
      await fetch(`/api/run/${runName}/stop`, { method: 'POST' })
    } catch (e) {
      console.error('Stop error:', e)
    }
  }

  const retryUnclassified = async () => {
    setIsRunning(true)
    setStatus('classifying')
    try {
      const res = await fetch(`/api/run/${runName}/retry-unclassified`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, batch_size: batchSize, include_notes: includeNotes, run_name: runName }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }))
        throw new Error(err.detail || 'Failed to start')
      }
      const data = await res.json()
      if (data.status === 'nothing_to_retry') {
        setIsRunning(false)
        setStatus('done')
        return
      }
      startPolling(runName)
    } catch (e) {
      setIsRunning(false)
      setStatus('done')
      console.error('Retry error:', e)
    }
  }

  const startClustering = async () => {
    setStatus('clustering')
    try {
      const res = await fetch(`/api/run/${runName}/cluster`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to start clustering')
      const poll = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/run/${runName}/cluster/status`)
          const data = await statusRes.json()
          if (data.status === 'completed') {
            clearInterval(poll)
            setStatus('done')
          } else if (data.status === 'failed') {
            clearInterval(poll)
            setStatus('done')
            console.error('Clustering failed:', data.error)
          }
        } catch { /* keep polling */ }
      }, 2000)
    } catch {
      setStatus('done')
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
  const isActive = status === 'classifying' || status === 'stopping'

  return (
    <div>
      <PageHeader
        title="Run Classification"
        description="Execute Tier 1+2 (LLM classification + entity extraction) and Tier 3 (semantic clustering)."
      />

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Configuration */}
        <Card>
          <h3 className="text-sm font-medium text-text-primary mb-4">Configuration</h3>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-text-muted mb-1">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isActive}
                className="w-full bg-bg3 border border-white/10 rounded-md px-3 py-2 text-sm text-text-primary"
              >
                <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                <option value="claude-sonnet-4-6-20250514">Claude Sonnet 4.6</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1">Batch Size</label>
              <input
                type="number"
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                disabled={isActive}
                min={10}
                max={100}
                className="w-full bg-bg3 border border-white/10 rounded-md px-3 py-2 text-sm text-text-primary"
              />
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1">Run Name</label>
              <input
                type="text"
                value={runName}
                onChange={(e) => setRunName(e.target.value)}
                disabled={isActive}
                className="w-full bg-bg3 border border-white/10 rounded-md px-3 py-2 text-sm text-text-primary"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-text-muted">
              <input
                type="checkbox"
                checked={includeNotes}
                onChange={(e) => setIncludeNotes(e.target.checked)}
                disabled={isActive}
                className="rounded"
              />
              Include AdditionalNotes field
            </label>

            {status === 'classifying' ? (
              <Button
                onClick={stopClassification}
                variant="secondary"
                size="lg"
                className="w-full"
              >
                Stop Classification
              </Button>
            ) : status === 'stopping' ? (
              <Button disabled size="lg" className="w-full" variant="secondary">
                Stopping...
              </Button>
            ) : status === 'stopped' ? (
              <Button onClick={startClassification} size="lg" className="w-full">
                Resume Classification
              </Button>
            ) : status === 'done' && progress.unclassified > 0 ? (
              <Button onClick={retryUnclassified} size="lg" className="w-full">
                Classify {progress.unclassified} Unclassified Items
              </Button>
            ) : status === 'done' ? (
              <Button disabled size="lg" className="w-full" variant="secondary">
                Classification Complete
              </Button>
            ) : (
              <Button
                onClick={startClassification}
                disabled={isActive}
                size="lg"
                className="w-full"
              >
                {progress.completed > 0 ? 'Resume Classification' : 'Start Classification'}
              </Button>
            )}
          </div>
        </Card>

        {/* Progress */}
        <Card>
          <h3 className="text-sm font-medium text-text-primary mb-4">Progress</h3>

          {status === 'idle' && progress.total === 0 && (
            <p className="text-sm text-text-dim">No run in progress. Configure and start a classification run.</p>
          )}

          {(progress.total > 0 || isActive) && (
            <div className="space-y-4">
              {/* Progress bar */}
              <div>
                <div className="flex justify-between text-xs text-text-muted mb-1">
                  <span>Tier 1+2: Classification + Entities</span>
                  <span>{progress.completed} / {progress.total} batches — {pct}%</span>
                </div>
                <div className="h-2 bg-bg3 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      status === 'stopping' ? 'bg-amber' : status === 'stopped' ? 'bg-text-dim' : 'bg-maize'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {progress.total > 0 && (
                  <div className="text-xs text-text-dim mt-1">
                    <p>
                      {progress.classifiedItems > 0
                        ? `${progress.classifiedItems.toLocaleString()} / ${progress.totalItems.toLocaleString()} unique items classified`
                        : `~${(progress.completed * batchSize).toLocaleString()} items classified`}
                    </p>
                    {progress.classifiedItems > 0 && progress.totalItems < 14242 && (
                      <p className="text-text-dim/60 mt-0.5">
                        Source has 14,242 rows but {(14242 - progress.totalItems).toLocaleString()} are duplicates
                      </p>
                    )}
                  </div>
                )}
              </div>

              {progress.errors > 0 && (
                <div className="text-xs">
                  <button
                    onClick={() => setShowErrors(!showErrors)}
                    className="text-coral hover:text-coral/80 cursor-pointer flex items-center gap-1"
                  >
                    <span className="inline-block transition-transform" style={{ transform: showErrors ? 'rotate(90deg)' : 'rotate(0deg)' }}>&#9654;</span>
                    {progress.errors} batch{progress.errors > 1 ? 'es' : ''} failed (will retry on resume)
                  </button>
                  {showErrors && progress.errorMessages.length > 0 && (
                    <div className="mt-2 space-y-1 pl-4 border-l border-coral/30">
                      {progress.errorMessages.map((err, i) => (
                        <div key={i} className="text-text-dim">
                          <span className="text-coral">Batch {err.batch}:</span>{' '}
                          <span className="break-all">{err.error}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {status === 'stopped' && (
                <div className="text-xs text-amber pt-1">
                  Stopped. Completed batches are saved. Click "Resume" to continue from where you left off.
                </div>
              )}

              {status === 'stopping' && (
                <div className="text-xs text-amber pt-1">
                  Stopping after current batch finishes...
                </div>
              )}

              {status === 'done' && (
                <div className="space-y-3 pt-2 border-t border-white/6">
                  <p className="text-xs text-teal">
                    {progress.errors > 0
                      ? `Classification complete with ${progress.errors} failed batch${progress.errors > 1 ? 'es' : ''}.`
                      : progress.unclassified > 0
                      ? `Classification complete. ${progress.unclassified} item${progress.unclassified > 1 ? 's' : ''} unclassified.`
                      : 'Classification complete.'}
                  </p>
                  {progress.errors > 0 && (
                    <Button onClick={startClassification} className="w-full">
                      Retry Failed Batches
                    </Button>
                  )}
                  {progress.unclassified > 0 && (
                    <Button onClick={retryUnclassified} className="w-full">
                      Classify {progress.unclassified} Unclassified Items
                    </Button>
                  )}
                  <Button onClick={startClustering} variant="secondary" className="w-full">
                    Run Tier 3 Clustering
                  </Button>
                </div>
              )}
            </div>
          )}

          {status === 'clustering' && (
            <div className="space-y-3">
              <div className="text-sm text-text-muted flex items-center gap-2">
                <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
                Running Tier 3 clustering (TF-IDF + UMAP + HDBSCAN)...
              </div>
              {progress.totalItems > 0 && (
                <div className="text-xs text-text-muted border-t border-white/6 pt-2">
                  Classification: {progress.classifiedItems.toLocaleString()} / {progress.totalItems.toLocaleString()} items classified
                  {progress.unclassified > 0 && ` · ${progress.unclassified} unclassified`}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
