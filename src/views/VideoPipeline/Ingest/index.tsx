import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '../../../components/PageHeader'
import { Card } from '../../../components/Card'
import { Button } from '../../../components/Button'

interface Keyframe {
  index: number
  timestamp: number
  path: string
  role?: string
}

interface Scene {
  scene_id: string
  start: number
  end: number
  duration?: number
  keyframes: Keyframe[]
}

interface IngestResult {
  video_id: string
  source_path: string
  source_public_path?: string | null
  duration: number
  scene_count: number
  scenes: Scene[]
  status: string
  created_at: string
  detector?: { name: string; threshold: number }
}

interface VideoSummary {
  video_id: string
  source_path?: string
  status?: string
  scene_count?: number
  created_at?: string
}

interface SourceVideo {
  name: string
  relative_path: string
  size_bytes: number
}

interface IngestStatus {
  status: 'running' | 'completed' | 'failed'
  phase:
    | 'queued'
    | 'probing'
    | 'detecting'
    | 'extracting'
    | 'completed'
    | 'failed'
  scenes_done?: number
  scenes_total?: number
  scene_count?: number
  duration?: number
  error?: string | null
}

const PHASE_LABEL: Record<IngestStatus['phase'], string> = {
  queued: 'Queued',
  probing: 'Probing duration (ffprobe)',
  detecting: 'Detecting scene boundaries (PySceneDetect)',
  extracting: 'Extracting keyframes (ffmpeg)',
  completed: 'Completed',
  failed: 'Failed',
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Derive a Vite-served URL for the source video.
 *
 * Vite serves anything under `public/` at the root, so a file at
 * `public/data/source/videos/foo.mp4` is reachable at
 * `/data/source/videos/foo.mp4`. We prefer the explicit
 * `source_public_path` field (relative to public/), and fall back to
 * parsing the absolute `source_path` for older ingest runs that
 * predate that field.
 */
function deriveVideoUrl(result: IngestResult): string | null {
  if (result.source_public_path) {
    return '/' + result.source_public_path.replace(/^\/+/, '')
  }
  // Fallback: find /public/ in the absolute source_path
  const marker = '/public/'
  const idx = result.source_path.lastIndexOf(marker)
  if (idx === -1) return null
  return '/' + result.source_path.slice(idx + marker.length)
}

export function Ingest() {
  const [sourceVideos, setSourceVideos] = useState<SourceVideo[]>([])
  const [sourcePath, setSourcePath] = useState('')
  const [videoId, setVideoId] = useState('')
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  const [status, setStatus] = useState<IngestStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<IngestResult | null>(null)
  const [videos, setVideos] = useState<VideoSummary[]>([])
  const [expandedScenes, setExpandedScenes] = useState<Set<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const toggleScene = (sceneId: string) => {
    setExpandedScenes((prev) => {
      const next = new Set(prev)
      if (next.has(sceneId)) next.delete(sceneId)
      else next.add(sceneId)
      return next
    })
  }

  const isRunning = status?.status === 'running'

  const refreshVideos = async () => {
    try {
      const res = await fetch('/api/video/videos')
      if (res.ok) setVideos(await res.json())
    } catch {
      /* ignore */
    }
  }

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const startPolling = (vid: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/ingest/${vid}/status`)
        if (!res.ok) return
        const data: IngestStatus = await res.json()
        setStatus(data)
        if (data.status === 'completed') {
          stopPolling()
          // Pull the full scenes.json now that it's on disk
          const scenesRes = await fetch(`/api/video/videos/${vid}/scenes`)
          if (scenesRes.ok) setResult(await scenesRes.json())
          refreshVideos()
        } else if (data.status === 'failed') {
          stopPolling()
          setError(data.error || 'Ingest failed')
          refreshVideos()
        }
      } catch {
        /* keep polling */
      }
    }, 1000)
  }

  useEffect(() => {
    refreshVideos()
    fetch('/api/video/source-videos')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SourceVideo[]) => {
        setSourceVideos(list)
        if (list.length > 0) setSourcePath(list[0].relative_path)
      })
      .catch(() => setSourceVideos([]))

    return () => stopPolling()
  }, [])

  const runIngest = async () => {
    if (!sourcePath.trim()) {
      setError('Provide a video path.')
      return
    }
    setError(null)
    setResult(null)
    setStatus({ status: 'running', phase: 'queued' })
    try {
      const res = await fetch('/api/video/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_path: sourcePath.trim(),
          video_id: videoId.trim() || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }))
        throw new Error(err.detail || 'Ingest failed')
      }
      const { video_id: vid } = await res.json()
      setActiveVideoId(vid)
      startPolling(vid)
    } catch (e) {
      setStatus(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const loadVideo = async (id: string) => {
    setError(null)
    setActiveVideoId(id)
    setStatus(null)
    setExpandedScenes(new Set())
    try {
      const res = await fetch(`/api/video/videos/${id}/scenes`)
      if (!res.ok) throw new Error(`Failed to load ${id}`)
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const renderProgress = () => {
    if (!status) return null
    const phaseLabel = PHASE_LABEL[status.phase] ?? status.phase
    const total = status.scenes_total ?? 0
    const done = status.scenes_done ?? 0
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    const showBar = status.phase === 'extracting' && total > 0

    return (
      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-text-muted">
          {status.status === 'running' && (
            <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
          )}
          <span>{phaseLabel}</span>
          {status.duration != null && status.phase !== 'probing' && (
            <span className="text-text-dim">
              · {fmtTime(status.duration)} clip
            </span>
          )}
        </div>
        {showBar && (
          <div>
            <div className="flex justify-between text-xs text-text-muted mb-1">
              <span>Keyframes</span>
              <span>
                {done} / {total} scenes — {pct}%
              </span>
            </div>
            <div className="h-2 bg-bg3 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-maize transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}
        {status.status === 'completed' && (
          <p className="text-xs text-teal">
            {status.scene_count} scenes detected.
          </p>
        )}
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Ingest & Segment"
        description="Stage 1 — probe duration (ffprobe), detect scene boundaries (PySceneDetect ContentDetector), extract start/mid/end keyframes per scene (ffmpeg)."
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h3 className="text-sm font-medium text-text-primary mb-4">Run Ingest</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-text-muted mb-1">
                Source Video{' '}
                <span className="text-text-dim">
                  (public/data/source/videos/)
                </span>
              </label>
              {sourceVideos.length > 0 ? (
                <select
                  value={sourcePath}
                  onChange={(e) => setSourcePath(e.target.value)}
                  disabled={isRunning}
                  className="w-full bg-bg3 border border-white/10 rounded-md px-3 py-2 text-sm text-text-primary font-mono"
                >
                  {sourceVideos.map((v) => (
                    <option key={v.relative_path} value={v.relative_path}>
                      {v.name} ({fmtBytes(v.size_bytes)})
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={sourcePath}
                  onChange={(e) => setSourcePath(e.target.value)}
                  disabled={isRunning}
                  placeholder="public/data/source/videos/clip.mp4 or absolute path"
                  className="w-full bg-bg3 border border-white/10 rounded-md px-3 py-2 text-sm text-text-primary font-mono"
                />
              )}
              {sourceVideos.length === 0 && (
                <p className="text-xs text-text-dim mt-1">
                  No videos found in public/data/source/videos/. Drop one in or
                  type any path manually.
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1">
                Video ID (optional — derived from filename if blank)
              </label>
              <input
                type="text"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                disabled={isRunning}
                placeholder="neoba_1978_03_14_news"
                className="w-full bg-bg3 border border-white/10 rounded-md px-3 py-2 text-sm text-text-primary font-mono"
              />
            </div>

            <Button onClick={runIngest} disabled={isRunning} size="lg" className="w-full">
              {isRunning ? 'Ingesting…' : 'Run Ingest'}
            </Button>

            {error && (
              <p className="text-xs text-coral break-words">{error}</p>
            )}

            {renderProgress()}
          </div>
        </Card>

        <Card>
          <h3 className="text-sm font-medium text-text-primary mb-4">
            Ingested Videos
          </h3>
          {videos.length === 0 ? (
            <p className="text-sm text-text-dim">
              Nothing ingested yet. Run Stage 1 above to create the first entry.
            </p>
          ) : (
            <ul className="space-y-2">
              {videos.map((v) => (
                <li
                  key={v.video_id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <button
                    type="button"
                    onClick={() => loadVideo(v.video_id)}
                    className={`text-left font-mono text-xs truncate ${
                      activeVideoId === v.video_id
                        ? 'text-maize'
                        : 'text-text-primary hover:text-maize'
                    }`}
                    title={v.source_path}
                  >
                    {v.video_id}
                  </button>
                  <span className="text-xs text-text-dim shrink-0">
                    {v.scene_count ?? '—'} scenes · {v.status ?? 'unknown'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {result && (
        <div className="mt-5">
          <Card>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-sm font-medium text-text-primary">
                  {result.video_id}
                </h3>
                <p className="text-xs text-text-dim font-mono mt-1 break-all">
                  {result.source_path}
                </p>
                <p className="text-xs text-text-dim mt-1">
                  {result.scene_count} scenes · duration {fmtTime(result.duration)} ·{' '}
                  status{' '}
                  <span
                    className={
                      result.status === 'completed' ? 'text-teal' : 'text-amber'
                    }
                  >
                    {result.status}
                  </span>
                  {result.detector && (
                    <>
                      {' · '}
                      {result.detector.name} (threshold {result.detector.threshold})
                    </>
                  )}
                </p>
              </div>
            </div>

            {(() => {
              const videoUrl = deriveVideoUrl(result)
              return (
            <div className="space-y-2 max-h-[640px] overflow-y-auto pr-1">
              {result.scenes.map((scene) => {
                const isExpanded = expandedScenes.has(scene.scene_id)
                return (
                  <div
                    key={scene.scene_id}
                    className="bg-bg3 rounded-md overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => toggleScene(scene.scene_id)}
                      className="w-full flex items-center justify-between gap-4 px-3 py-2 text-xs text-left hover:bg-white/3 transition-colors"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-text-dim w-3 text-center">
                          {isExpanded ? '▾' : '▸'}
                        </span>
                        <span className="font-mono text-text-primary truncate">
                          {scene.scene_id}
                        </span>
                      </span>
                      <span className="text-text-muted shrink-0">
                        {fmtTime(scene.start)} → {fmtTime(scene.end)}
                        {scene.duration != null && (
                          <span className="text-text-dim">
                            {' '}
                            ({scene.duration.toFixed(1)}s)
                          </span>
                        )}
                      </span>
                      <span className="text-text-dim shrink-0">
                        {scene.keyframes.length} keyframe
                        {scene.keyframes.length === 1 ? '' : 's'}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-2 space-y-3 border-t border-white/6">
                        {videoUrl ? (
                          <video
                            key={`${scene.scene_id}-${scene.start}-${scene.end}`}
                            src={`${videoUrl}#t=${scene.start.toFixed(3)},${scene.end.toFixed(3)}`}
                            controls
                            preload="metadata"
                            className="w-full max-w-md rounded border border-white/10 bg-black"
                          />
                        ) : (
                          <p className="text-[11px] text-text-dim italic">
                            Source video not under public/ — clip preview unavailable.
                          </p>
                        )}
                        {scene.keyframes.length > 0 && (
                        <div className="flex gap-3 flex-wrap">
                        {scene.keyframes.map((kf) => {
                          const filename = kf.path.split('/').pop() ?? ''
                          const url = `/api/video/videos/${result.video_id}/keyframes/${filename}`
                          return (
                            <figure
                              key={kf.path}
                              className="flex flex-col items-center gap-1"
                            >
                              <img
                                src={url}
                                alt={`${scene.scene_id} ${kf.role ?? kf.index}`}
                                loading="lazy"
                                className="h-32 w-auto rounded border border-white/10 bg-black"
                              />
                              <figcaption className="text-[10px] text-text-dim font-mono">
                                {kf.role ?? `frame ${kf.index}`} · {fmtTime(kf.timestamp)}
                              </figcaption>
                            </figure>
                          )
                        })}
                        </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
              )
            })()}
          </Card>
        </div>
      )}
    </div>
  )
}
