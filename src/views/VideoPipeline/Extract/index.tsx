import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '../../../components/PageHeader'
import { Card } from '../../../components/Card'
import { Button } from '../../../components/Button'

interface VideoSummary {
  video_id: string
  source_path?: string
  status?: string
  scene_count?: number
  created_at?: string
}

interface TranscriptSegment {
  id: number
  start: number
  end: number
  text: string
}

interface CleanupStats {
  applied: boolean
  removed_count?: number
  modified_count?: number
  kept_count?: number
  removed_hallucination?: number
  removed_adjacent_duplicate?: number
  modified_word_run_collapse?: number
  rules?: string[]
}

interface Transcript {
  video_id: string
  model: string
  language: string
  duration: number
  text: string
  segments: TranscriptSegment[]
  segments_raw?: TranscriptSegment[]
  cleanup?: CleanupStats
  audio_path: string
  word_timestamps: boolean
  created_at: string
  status: string
  elapsed_seconds?: number
}

interface IngestResult {
  video_id: string
  source_path: string
  source_public_path?: string | null
}

type TranscribePhase =
  | 'queued'
  | 'extracting_audio'
  | 'loading_model'
  | 'transcribing'
  | 'writing'
  | 'completed'
  | 'failed'

interface TranscribeStatus {
  status: 'running' | 'completed' | 'failed'
  phase: TranscribePhase
  model?: string
  word_timestamps?: boolean
  segment_count?: number
  elapsed_seconds?: number
  language?: string
  cached?: boolean
  error?: string | null
}

const PHASE_LABEL: Record<TranscribePhase, string> = {
  queued: 'Queued',
  extracting_audio: 'Extracting audio track (ffmpeg)',
  loading_model: 'Loading mlx-whisper model',
  transcribing: 'Transcribing (mlx-whisper)',
  writing: 'Writing transcript.json',
  completed: 'Completed',
  failed: 'Failed',
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Vite serves anything under `public/` at the root, so a file at
 * `public/data/source/videos/foo.mp4` is reachable at
 * `/data/source/videos/foo.mp4`. We prefer `source_public_path` and fall
 * back to parsing the absolute `source_path` for old runs.
 */
function deriveVideoUrl(ingest: IngestResult): string | null {
  if (ingest.source_public_path) {
    return '/' + ingest.source_public_path.replace(/^\/+/, '')
  }
  const marker = '/public/'
  const idx = ingest.source_path.lastIndexOf(marker)
  if (idx === -1) return null
  return '/' + ingest.source_path.slice(idx + marker.length)
}

export function Extract() {
  const [videos, setVideos] = useState<VideoSummary[]>([])
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  const [ingest, setIngest] = useState<IngestResult | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [status, setStatus] = useState<TranscribeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'cleaned' | 'raw'>('cleaned')
  const [recleaning, setRecleaning] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const isRunning = status?.status === 'running'

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const refreshVideos = async () => {
    try {
      const res = await fetch('/api/video/videos')
      if (res.ok) setVideos(await res.json())
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refreshVideos()
    return () => stopPolling()
  }, [])

  const loadVideo = async (id: string) => {
    stopPolling()
    setError(null)
    setActiveVideoId(id)
    setIngest(null)
    setTranscript(null)
    setStatus(null)

    // Always pull scenes.json so we have source_path / source_public_path
    // for the <video> element.
    try {
      const sRes = await fetch(`/api/video/videos/${id}/scenes`)
      if (sRes.ok) setIngest(await sRes.json())
    } catch {
      /* non-fatal — transcript still viewable without player */
    }

    // Check if a transcript already exists.
    try {
      const tRes = await fetch(`/api/video/videos/${id}/transcript`)
      if (tRes.ok) {
        const t: Transcript = await tRes.json()
        setTranscript(t)
        setStatus({
          status: 'completed',
          phase: 'completed',
          segment_count: t.segments.length,
          language: t.language,
          elapsed_seconds: t.elapsed_seconds,
        })
      }
    } catch {
      /* no transcript yet — that's fine */
    }
  }

  const startPolling = (id: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/video/transcribe/${id}/status`)
        if (!res.ok) return
        const data: TranscribeStatus = await res.json()
        setStatus(data)
        if (data.status === 'completed') {
          stopPolling()
          const tRes = await fetch(`/api/video/videos/${id}/transcript`)
          if (tRes.ok) setTranscript(await tRes.json())
        } else if (data.status === 'failed') {
          stopPolling()
          setError(data.error || 'Transcription failed')
        }
      } catch {
        /* keep polling */
      }
    }, 1000)
  }

  const reclean = async () => {
    if (!activeVideoId) return
    setRecleaning(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/video/transcribe/${activeVideoId}/reclean`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: 'Reclean failed' }))
        throw new Error(err.detail || 'Reclean failed')
      }
      const t: Transcript = await res.json()
      setTranscript(t)
      setView('cleaned')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRecleaning(false)
    }
  }

  const runTranscribe = async (force = false) => {
    if (!activeVideoId) {
      setError('Pick an ingested video first.')
      return
    }
    setError(null)
    setTranscript(null)
    setStatus({ status: 'running', phase: 'queued' })
    try {
      const res = await fetch('/api/video/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: activeVideoId,
          force,
        }),
      })
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: 'Unknown error' }))
        throw new Error(err.detail || 'Transcribe failed')
      }
      startPolling(activeVideoId)
    } catch (e) {
      setStatus(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const seekTo = (t: number) => {
    const el = videoRef.current
    if (!el) return
    el.currentTime = Math.max(0, t)
    void el.play().catch(() => {
      /* user gesture may be required; ignore */
    })
  }

  const renderProgress = () => {
    if (!status) return null
    const phaseLabel = PHASE_LABEL[status.phase] ?? status.phase
    return (
      <div className="mt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2 text-text-muted">
          {status.status === 'running' && (
            <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
          )}
          <span>{phaseLabel}</span>
          {status.model && (
            <span className="text-text-dim text-xs">· {status.model}</span>
          )}
        </div>
        {status.status === 'completed' && (
          <p className="text-xs text-teal">
            {status.segment_count ?? transcript?.segments.length ?? 0}{' '}
            segments
            {status.language && ` · ${status.language}`}
            {status.elapsed_seconds != null &&
              ` · ${status.elapsed_seconds.toFixed(1)}s`}
            {status.cached && ' · cached'}
          </p>
        )}
      </div>
    )
  }

  const videoUrl = ingest ? deriveVideoUrl(ingest) : null

  return (
    <div>
      <PageHeader
        title="Extract"
        description="Stage 2 — per-modality extraction. Currently: mlx-whisper (large-v3-turbo) speech-to-text. VLM captioning, Apple Vision OCR, and InsightFace embeddings to follow."
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h3 className="text-sm font-medium text-text-primary mb-4">
            Ingested Videos
          </h3>
          {videos.length === 0 ? (
            <p className="text-sm text-text-dim">
              Nothing ingested yet. Run Stage 1 Ingest first.
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
                    {v.scene_count ?? '—'} scenes
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h3 className="text-sm font-medium text-text-primary mb-4">
            Transcribe (mlx-whisper)
          </h3>
          {!activeVideoId ? (
            <p className="text-sm text-text-dim">
              Select an ingested video on the left to transcribe.
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-text-muted font-mono break-all">
                {activeVideoId}
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={() => runTranscribe(false)}
                  disabled={isRunning}
                  size="lg"
                  className="flex-1"
                >
                  {isRunning
                    ? 'Transcribing…'
                    : transcript
                      ? 'Re-run (cached)'
                      : 'Transcribe'}
                </Button>
                {transcript && (
                  <Button
                    onClick={() => runTranscribe(true)}
                    disabled={isRunning}
                    size="lg"
                    variant="secondary"
                  >
                    Force
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-text-dim">
                Model: <code>mlx-community/whisper-large-v3-turbo</code>.
                Runs on the audio track extracted during Stage 1 (or
                extracted on-the-fly for older runs). First run downloads
                ~1.5 GB to the HuggingFace cache.
              </p>
              {error && <p className="text-xs text-coral break-words">{error}</p>}
              {renderProgress()}
            </div>
          )}
        </Card>
      </div>

      {transcript && (() => {
        const cleanedSegs = transcript.segments
        const rawSegs = transcript.segments_raw ?? transcript.segments
        const displayedSegs = view === 'raw' ? rawSegs : cleanedSegs
        const removed = transcript.cleanup?.removed_count ?? 0
        const modified = transcript.cleanup?.modified_count ?? 0
        const hasRaw = !!transcript.segments_raw
        return (
        <div className="mt-5">
          <Card>
            <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
              <div>
                <h3 className="text-sm font-medium text-text-primary">
                  Transcript — {transcript.video_id}
                </h3>
                <p className="text-xs text-text-dim mt-1">
                  {cleanedSegs.length} segments · {transcript.language}{' '}
                  · {fmtTime(transcript.duration)} · model{' '}
                  <span className="font-mono">{transcript.model}</span>
                  {transcript.elapsed_seconds != null && (
                    <> · transcribed in {transcript.elapsed_seconds.toFixed(1)}s</>
                  )}
                </p>
                {transcript.cleanup?.applied && (removed > 0 || modified > 0) && (
                  <p className="text-[11px] text-text-dim mt-1">
                    Cleanup:{' '}
                    <span className="text-teal">{removed} removed</span>
                    {transcript.cleanup.removed_hallucination != null && (
                      <> ({transcript.cleanup.removed_hallucination} hallucination,{' '}
                      {transcript.cleanup.removed_adjacent_duplicate ?? 0} adjacent dup)</>
                    )}
                    {modified > 0 && (
                      <>, <span className="text-teal">{modified} word-run collapsed</span></>
                    )}
                    {' · raw '}
                    {rawSegs.length} segments
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {hasRaw && (
                  <div className="inline-flex rounded border border-white/10 overflow-hidden text-[11px]">
                    <button
                      type="button"
                      onClick={() => setView('cleaned')}
                      className={`px-2 py-1 ${
                        view === 'cleaned'
                          ? 'bg-bg3 text-maize'
                          : 'text-text-dim hover:text-text-primary'
                      }`}
                    >
                      Cleaned ({cleanedSegs.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setView('raw')}
                      className={`px-2 py-1 border-l border-white/10 ${
                        view === 'raw'
                          ? 'bg-bg3 text-maize'
                          : 'text-text-dim hover:text-text-primary'
                      }`}
                    >
                      Raw ({rawSegs.length})
                    </button>
                  </div>
                )}
                <Button
                  onClick={reclean}
                  disabled={recleaning || isRunning}
                  size="sm"
                  variant="secondary"
                  title="Re-apply cleanup rules to the existing transcript without re-running Whisper"
                >
                  {recleaning ? 'Re-cleaning…' : 'Re-clean'}
                </Button>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div>
                {videoUrl ? (
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    preload="metadata"
                    className="w-full rounded border border-white/10 bg-black sticky top-4"
                  />
                ) : (
                  <p className="text-[11px] text-text-dim italic">
                    Source video not under public/ — inline playback
                    unavailable. Transcript segments still click-navigable
                    as timestamps only.
                  </p>
                )}
              </div>

              <div className="max-h-[640px] overflow-y-auto pr-1 space-y-1">
                {displayedSegs.map((seg) => (
                  <button
                    key={`${view}-${seg.id}`}
                    type="button"
                    onClick={() => seekTo(seg.start)}
                    className="w-full text-left px-3 py-2 rounded hover:bg-bg3 transition-colors group"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="text-[10px] font-mono text-text-dim shrink-0 group-hover:text-maize">
                        {fmtTime(seg.start)}
                      </span>
                      <span className="text-sm text-text-primary leading-snug">
                        {seg.text}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </Card>
        </div>
        )
      })()}
    </div>
  )
}
