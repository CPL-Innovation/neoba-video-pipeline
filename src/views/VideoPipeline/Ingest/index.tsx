import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '../../../components/PageHeader'
import { Card } from '../../../components/Card'
import { Button } from '../../../components/Button'

// ── Types ───────────────────────────────────────────────────────────────

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
  merged_from?: string[]
  merge_status?: 'pending' | 'committed'
  tags?: string[]
}

interface VlmAnalysis {
  summary: string
  full_analysis: string
  model: string
  prompt: string
  analyzed_at: string
}

interface Segment {
  segment_id: string
  type: 'content' | 'boundary'
  name: string
  scene_ids: string[]
  start: number
  end: number
  vlm_analysis?: VlmAnalysis
}

interface TranscriptSegment {
  id: number
  start: number
  end: number
  text: string
}

interface MergeGroup {
  group_id: string
  scene_ids: string[]
  status: 'pending' | 'committed'
  created_at: string
  committed_at?: string
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
  raw_scene_count?: number
  merge_groups?: MergeGroup[]
  segments?: Segment[]
  segment_detector?: { luminance_threshold: number; min_duration: number }
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
    | 'extracting_audio'
    | 'detecting'
    | 'extracting'
    | 'completed'
    | 'failed'
  scenes_done?: number
  scenes_total?: number
  scene_count?: number
  duration?: number
  error?: string | null
  audio_error?: string | null
}

const PHASE_LABEL: Record<IngestStatus['phase'], string> = {
  queued: 'Queued',
  probing: 'Probing duration (ffprobe)',
  extracting_audio: 'Extracting audio track (ffmpeg)',
  detecting: 'Detecting scene boundaries (PySceneDetect)',
  extracting: 'Extracting keyframes (ffmpeg)',
  completed: 'Completed',
  failed: 'Failed',
}

// ── Helpers ─────────────────────────────────────────────────────────────

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

function deriveVideoUrl(result: IngestResult): string | null {
  if (result.source_public_path) {
    return '/' + result.source_public_path.replace(/^\/+/, '')
  }
  const marker = '/public/'
  const idx = result.source_path.lastIndexOf(marker)
  if (idx === -1) return null
  return '/' + result.source_path.slice(idx + marker.length)
}

function keyframeUrl(videoId: string, kf: Keyframe): string {
  const filename = kf.path.split('/').pop() ?? ''
  return `/api/video/videos/${videoId}/keyframes/${filename}`
}

// ── Scene-scoped video player ───────────────────────────────────────────

function ScenePlayer({
  src,
  sceneStart,
  sceneEnd,
  transcriptSegments,
  onTimeUpdate,
}: {
  src: string
  sceneStart: number
  sceneEnd: number
  transcriptSegments?: TranscriptSegment[] | null
  onTimeUpdate?: (absoluteTime: number) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrent] = useState(0) // relative to sceneStart
  const [dragging, setDragging] = useState(false)
  const sceneDuration = sceneEnd - sceneStart

  // Filter transcript segments that overlap this scene/segment range
  const activeSegments = useMemo(() => {
    if (!transcriptSegments || transcriptSegments.length === 0) return []
    return transcriptSegments.filter(
      (seg) => seg.end > sceneStart && seg.start < sceneEnd && seg.text.trim(),
    )
  }, [transcriptSegments, sceneStart, sceneEnd])

  // Current subtitle text based on playback position
  const [subtitleText, setSubtitleText] = useState('')

  // Clamp video to scene bounds
  const clamp = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.currentTime < sceneStart) v.currentTime = sceneStart
    if (v.currentTime >= sceneEnd) {
      v.currentTime = sceneStart
      v.pause()
      setPlaying(false)
    }
  }, [sceneStart, sceneEnd])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      clamp()
      const t = v.currentTime
      setCurrent(t - sceneStart)
      onTimeUpdate?.(t)
      // Update subtitle
      if (activeSegments.length > 0) {
        const seg = activeSegments.find((s) => t >= s.start && t < s.end)
        setSubtitleText(seg?.text.trim() ?? '')
      }
    }
    const onPause = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('pause', onPause)
    v.addEventListener('play', onPlay)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('play', onPlay)
    }
  }, [sceneStart, clamp, activeSegments])

  // Reset on scene change
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = sceneStart
    setCurrent(0)
    setPlaying(false)
  }, [src, sceneStart, sceneEnd])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (v.currentTime >= sceneEnd - 0.1) v.currentTime = sceneStart
      v.play()
    } else {
      v.pause()
    }
  }

  const seekFromEvent = (e: React.MouseEvent | MouseEvent) => {
    const track = trackRef.current
    const v = videoRef.current
    if (!track || !v) return
    const rect = track.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    v.currentTime = sceneStart + pct * sceneDuration
    setCurrent(pct * sceneDuration)
  }

  const onTrackDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    seekFromEvent(e)
    const onMove = (ev: MouseEvent) => seekFromEvent(ev)
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const pct = sceneDuration > 0 ? (currentTime / sceneDuration) * 100 : 0

  return (
    <div className="relative rounded border border-white/10 bg-black overflow-hidden">
      <video
        ref={videoRef}
        src={`${src}#t=${sceneStart.toFixed(3)},${sceneEnd.toFixed(3)}`}
        preload="metadata"
        className="w-full block"
        onClick={togglePlay}
      />

      {/* Subtitle overlay */}
      {subtitleText && (
        <div className="absolute bottom-12 left-2 right-2 flex justify-center pointer-events-none">
          <span className="bg-black/80 text-white text-xs px-2 py-1 rounded max-w-[90%] text-center leading-relaxed">
            {subtitleText}
          </span>
        </div>
      )}

      {/* Custom controls overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-4">
        {/* Seek bar */}
        <div
          ref={trackRef}
          className="group h-3 flex items-center cursor-pointer mb-1"
          onMouseDown={onTrackDown}
        >
          <div className="w-full h-1 group-hover:h-1.5 bg-white/20 rounded-full relative transition-all">
            <div
              className="absolute top-0 left-0 h-full bg-maize rounded-full"
              style={{ width: `${pct}%` }}
            />
            <div
              className={`absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-maize rounded-full shadow transition-opacity ${
                dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              style={{ left: `${pct}%`, marginLeft: '-5px' }}
            />
          </div>
        </div>

        {/* Play + time */}
        <div className="flex items-center gap-2 text-[11px] text-white/80 font-mono tabular-nums">
          <button
            type="button"
            onClick={togglePlay}
            className="hover:text-white text-sm leading-none"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <span>
            {fmtTime(sceneStart + currentTime)} / {fmtTime(sceneEnd)}
          </span>
          <span className="text-white/40 ml-auto">
            {currentTime.toFixed(1)}s / {sceneDuration.toFixed(1)}s
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Transcript editor panel ────────────────────────────────────────────

function TranscriptPanel({
  segments,
  videoId,
  onUpdate,
  onSeek,
}: {
  segments: TranscriptSegment[]
  videoId: string
  onUpdate: (updated: TranscriptSegment[]) => void
  onSeek?: (time: number) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  const saveSegment = async (id: number, text: string) => {
    try {
      const res = await fetch(
        `/api/video/videos/${videoId}/transcript/segments`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ id, text }] }),
        },
      )
      if (res.ok) {
        const data = await res.json()
        onUpdate(data.segments)
      }
    } catch {
      /* silent */
    }
    setEditingId(null)
  }

  const deleteSegment = async (id: number) => {
    try {
      const res = await fetch(
        `/api/video/videos/${videoId}/transcript/segments`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deletions: [id] }),
        },
      )
      if (res.ok) {
        const data = await res.json()
        onUpdate(data.segments)
      }
    } catch {
      /* silent */
    }
  }

  if (segments.length === 0) {
    return (
      <div className="text-xs text-text-dim italic py-2">
        No transcript segments in this range.
      </div>
    )
  }

  return (
    <div className="space-y-1 max-h-48 overflow-y-auto">
      {segments.map((seg) => (
        <div
          key={seg.id}
          className="flex gap-2 items-start text-xs group/seg"
        >
          <span
            className={`shrink-0 font-mono tabular-nums pt-1 w-20 ${
              onSeek
                ? 'text-text-muted hover:text-maize cursor-pointer'
                : 'text-text-dim'
            }`}
            onClick={() => onSeek?.(seg.start)}
            title="Jump to this segment"
          >
            {fmtTime(seg.start)}–{fmtTime(seg.end)}
          </span>
          {editingId === seg.id ? (
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onBlur={() => saveSegment(seg.id, editText)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  saveSegment(seg.id, editText)
                }
                if (e.key === 'Escape') setEditingId(null)
              }}
              autoFocus
              rows={2}
              className="flex-1 bg-bg3 border border-maize/50 rounded px-2 py-1 text-text-primary text-xs resize-none focus:outline-none"
            />
          ) : (
            <span
              className="flex-1 text-text-muted cursor-text py-1 hover:text-text-primary"
              onClick={() => {
                setEditingId(seg.id)
                setEditText(seg.text)
              }}
            >
              {seg.text.trim() || '(empty)'}
            </span>
          )}
          <button
            type="button"
            onClick={() => deleteSegment(seg.id)}
            className="shrink-0 text-text-dim hover:text-coral text-xs leading-none pt-1 opacity-0 group-hover/seg:opacity-100 transition-opacity"
            title="Delete segment"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────

export function Ingest() {
  // Level navigation: 'list' = video hub, 'scenes' = scene browser
  const [view, setView] = useState<'list' | 'scenes'>('list')

  // Level 1 state
  const [sourceVideos, setSourceVideos] = useState<SourceVideo[]>([])
  const [sourcePath, setSourcePath] = useState('')
  const [videoId, setVideoId] = useState('')
  const [status, setStatus] = useState<IngestStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [videos, setVideos] = useState<VideoSummary[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Level 2 state
  const [result, setResult] = useState<IngestResult | null>(null)
  const [previewSceneId, setPreviewSceneId] = useState<string | null>(null)
  const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set())
  const [lastClickedSceneId, setLastClickedSceneId] = useState<string | null>(
    null,
  )
  const [merging, setMerging] = useState(false)
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [durationMin, setDurationMin] = useState('')
  const [durationMax, setDurationMax] = useState('')
  const [editingTimeSceneId, setEditingTimeSceneId] = useState<string | null>(
    null,
  )
  const [editingTimeValue, setEditingTimeValue] = useState('')
  const [detectingSegments, setDetectingSegments] = useState(false)
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null)
  const [editingSegmentName, setEditingSegmentName] = useState('')
  const [collapsedSegments, setCollapsedSegments] = useState<Set<string>>(
    new Set(),
  )
  const [segmentFilter, setSegmentFilter] = useState<
    'all' | 'content' | 'boundary'
  >('all')
  const [previewSegmentId, setPreviewSegmentId] = useState<string | null>(null)
  const [transcriptSegments, setTranscriptSegments] = useState<
    TranscriptSegment[] | null
  >(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const [validTags, setValidTags] = useState<string[]>([])
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState<number | null>(
    null,
  )
  const [vlmPromptSegmentId, setVlmPromptSegmentId] = useState<string | null>(
    null,
  )
  const [vlmPrompt, setVlmPrompt] = useState(
    'Analyze this archival video segment. Describe: (1) what is visually happening, (2) any identifiable people, locations, or text on screen, (3) the apparent era and production style, (4) the type of content (interview, b-roll, news report, etc.).',
  )
  const [vlmRunning, setVlmRunning] = useState<string | null>(null)
  const [showVlmAnalysis, setShowVlmAnalysis] = useState(false)

  const isRunning = status?.status === 'running'
  const previewScene = result?.scenes.find(
    (s) => s.scene_id === previewSceneId,
  )
  const previewSegment = previewSegmentId
    ? result?.segments?.find((c) => c.segment_id === previewSegmentId) ?? null
    : null
  const videoUrl = result ? deriveVideoUrl(result) : null

  const pendingMergeCount =
    result?.merge_groups?.filter((g) => g.status === 'pending').length ?? 0

  // Build segment lookup: scene_id → segment
  const segmentBySceneId = new Map<string, Segment>()
  if (result?.segments) {
    for (const ch of result.segments) {
      for (const sid of ch.scene_ids) {
        segmentBySceneId.set(sid, ch)
      }
    }
  }

  // Duration filter
  const durationMinNum = durationMin === '' ? null : parseFloat(durationMin)
  const durationMaxNum = durationMax === '' ? null : parseFloat(durationMax)
  const hasDurationFilter =
    (durationMinNum !== null && !isNaN(durationMinNum)) ||
    (durationMaxNum !== null && !isNaN(durationMaxNum))

  const filteredScenes = result?.scenes.filter((scene) => {
    const dur = scene.duration ?? scene.end - scene.start
    if (durationMinNum !== null && !isNaN(durationMinNum) && dur < durationMinNum)
      return false
    if (durationMaxNum !== null && !isNaN(durationMaxNum) && dur > durationMaxNum)
      return false
    // Segment type filter
    if (segmentFilter !== 'all' && segmentBySceneId.size > 0) {
      const ch = segmentBySceneId.get(scene.scene_id)
      if (ch && ch.type !== segmentFilter) return false
    }
    return true
  })

  // ── Selection & merge logic ───────────────────────────────────────────

  const handleSelectScene = (sceneId: string, shiftKey: boolean) => {
    if (!result) return
    const ids = result.scenes.map((s) => s.scene_id)
    if (shiftKey && lastClickedSceneId) {
      const a = ids.indexOf(lastClickedSceneId)
      const b = ids.indexOf(sceneId)
      if (a === -1 || b === -1) return
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const rangeIds = ids.slice(lo, hi + 1)
      const adding = !selectedScenes.has(sceneId)
      setSelectedScenes((prev) => {
        const next = new Set(prev)
        for (const id of rangeIds) {
          if (adding) next.add(id)
          else next.delete(id)
        }
        return next
      })
    } else {
      setSelectedScenes((prev) => {
        const next = new Set(prev)
        if (next.has(sceneId)) next.delete(sceneId)
        else next.add(sceneId)
        return next
      })
    }
    setLastClickedSceneId(sceneId)
  }

  const clearSelection = () => {
    setSelectedScenes(new Set())
    setLastClickedSceneId(null)
  }

  const selectionInfo = (() => {
    if (!result || selectedScenes.size === 0) return null
    const ids = result.scenes.map((s) => s.scene_id)
    const positions = ids
      .map((id, i) => (selectedScenes.has(id) ? i : -1))
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)
    if (positions.length === 0) return null
    const first = result.scenes[positions[0]]
    const last = result.scenes[positions[positions.length - 1]]
    const contiguous =
      positions[positions.length - 1] - positions[0] === positions.length - 1
    return {
      count: positions.length,
      contiguous,
      start: first.start,
      end: last.end,
      orderedIds: positions.map((i) => ids[i]),
    }
  })()

  const mergeSelected = async () => {
    if (!result || !selectionInfo || !selectionInfo.contiguous) return
    setMerging(true)
    setError(null)
    try {
      const res = await fetch(`/api/video/videos/${result.video_id}/merges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene_ids: selectionInfo.orderedIds }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Merge failed' }))
        throw new Error(err.detail || 'Merge failed')
      }
      setResult(await res.json())
      clearSelection()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMerging(false)
    }
  }

  const unmergeGroup = async (groupId: string) => {
    if (!result) return
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/merges/${groupId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: 'Unmerge failed' }))
        throw new Error(err.detail || 'Unmerge failed')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const applyAllMerges = async () => {
    if (!result || pendingMergeCount === 0) return
    const ok = window.confirm(
      `Apply ${pendingMergeCount} pending merge${
        pendingMergeCount === 1 ? '' : 's'
      }?\n\nThis bakes merged scenes into scenes.json. Re-run scene detection to undo.`,
    )
    if (!ok) return
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/merges/apply`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Apply failed' }))
        throw new Error(err.detail || 'Apply failed')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Inline rename ─────────────────────────────────────────────────────

  const startEditing = (sceneId: string) => {
    setEditingSceneId(sceneId)
    setEditingName(sceneId)
  }

  const commitRename = async () => {
    if (!result || !editingSceneId) return
    const newId = editingName.trim()
    if (!newId || newId === editingSceneId) {
      setEditingSceneId(null)
      return
    }
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/scenes/rename`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old_id: editingSceneId, new_id: newId }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Rename failed' }))
        throw new Error(err.detail || 'Rename failed')
      }
      const updated = await res.json()
      setResult(updated)
      // Update preview if we renamed the previewed scene
      if (previewSceneId === editingSceneId) setPreviewSceneId(newId)
      // Update selection
      if (selectedScenes.has(editingSceneId)) {
        setSelectedScenes((prev) => {
          const next = new Set(prev)
          next.delete(editingSceneId!)
          next.add(newId)
          return next
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditingSceneId(null)
    }
  }

  const cancelEditing = () => setEditingSceneId(null)

  // ── Time range editing ──────────────────────────────────────────────

  const parseTime = (str: string): number | null => {
    const parts = str.split(':')
    if (parts.length !== 2) return null
    const m = parseInt(parts[0], 10)
    const s = parseFloat(parts[1])
    if (isNaN(m) || isNaN(s)) return null
    return m * 60 + s
  }

  const startEditingTime = (sceneId: string, start: number, end: number) => {
    setEditingTimeSceneId(sceneId)
    setEditingTimeValue(`${fmtTime(start)}→${fmtTime(end)}`)
  }

  const commitTimeRange = async () => {
    if (!result || !editingTimeSceneId) return
    const parts = editingTimeValue.split('→')
    if (parts.length !== 2) {
      setEditingTimeSceneId(null)
      return
    }
    const newStart = parseTime(parts[0].trim())
    const newEnd = parseTime(parts[1].trim())
    if (newStart === null || newEnd === null || newStart >= newEnd) {
      setEditingTimeSceneId(null)
      return
    }
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/scenes/time-range`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scene_id: editingTimeSceneId,
            start: newStart,
            end: newEnd,
          }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Failed' }))
        throw new Error(err.detail || 'Failed')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditingTimeSceneId(null)
    }
  }

  // ── Keyframe deletion ────────────────────────────────────────────────

  const deleteKeyframe = async (sceneId: string, kfPath: string) => {
    if (!result) return
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/scenes/delete-keyframe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene_id: sceneId, keyframe_path: kfPath }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Delete failed' }))
        throw new Error(err.detail || 'Delete failed')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Segment actions ───────────────────────────────────────────────────

  const runDetectSegments = async () => {
    if (!result) return
    setDetectingSegments(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/segments/detect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: 'Segment detection failed' }))
        throw new Error(err.detail || 'Segment detection failed')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetectingSegments(false)
    }
  }

  const clearSegments = async () => {
    if (!result) return
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/segments`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: 'Clear failed' }))
        throw new Error(err.detail || 'Clear failed')
      }
      setResult(await res.json())
      setCollapsedSegments(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const commitSegmentRename = async () => {
    if (!result || !editingSegmentId) return
    const newName = editingSegmentName.trim()
    if (!newName) {
      setEditingSegmentId(null)
      return
    }
    setError(null)
    try {
      const res = await fetch(
        `/api/video/videos/${result.video_id}/segments/${editingSegmentId}/rename`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        },
      )
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: 'Rename failed' }))
        throw new Error(err.detail || 'Rename failed')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditingSegmentId(null)
    }
  }

  const toggleSegmentCollapsed = (segmentId: string) => {
    setCollapsedSegments((prev) => {
      const next = new Set(prev)
      if (next.has(segmentId)) next.delete(segmentId)
      else next.add(segmentId)
      return next
    })
  }

  const runVlmAnalysis = async (segmentId: string) => {
    if (!result) return
    setVlmRunning(segmentId)
    setVlmPromptSegmentId(null)
    setError(null)
    try {
      // Kick off background job
      const res = await fetch(
        `/api/video/videos/${result.video_id}/segments/${segmentId}/analyze`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: vlmPrompt }),
        },
      )
      if (!res.ok) {
        const err = await res
          .json()
          .catch(() => ({ detail: 'VLM analysis failed' }))
        throw new Error(err.detail || 'VLM analysis failed')
      }
      // Poll for completion
      const pollUrl = `/api/video/videos/${result.video_id}/segments/${segmentId}/analyze/status`
      while (true) {
        await new Promise((r) => setTimeout(r, 3000))
        const statusRes = await fetch(pollUrl)
        if (!statusRes.ok) continue
        const status = await statusRes.json()
        if (status.status === 'completed') {
          // Refresh scenes to pick up the stored result
          const scenesRes = await fetch(
            `/api/video/videos/${result.video_id}/scenes`,
          )
          if (scenesRes.ok) setResult(await scenesRes.json())
          setShowVlmAnalysis(true)
          break
        }
        if (status.status === 'failed') {
          throw new Error(status.error || 'VLM analysis failed')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setVlmRunning(null)
    }
  }

  // ── Data fetching ─────────────────────────────────────────────────────

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
          const scenesRes = await fetch(`/api/video/videos/${vid}/scenes`)
          if (scenesRes.ok) {
            setResult(await scenesRes.json())
            setView('scenes')
          }
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
        const err = await res
          .json()
          .catch(() => ({ detail: 'Unknown error' }))
        throw new Error(err.detail || 'Ingest failed')
      }
      const { video_id: vid } = await res.json()
      startPolling(vid)
    } catch (e) {
      setStatus(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openVideo = async (id: string) => {
    setError(null)
    setStatus(null)
    setPreviewSceneId(null)
    setPreviewSegmentId(null)
    setTranscriptSegments(null)
    clearSelection()
    try {
      const res = await fetch(`/api/video/videos/${id}/scenes`)
      if (!res.ok) throw new Error(`Failed to load ${id}`)
      const data: IngestResult = await res.json()
      setResult(data)
      setView('scenes')
      // Auto-preview the first scene
      if (data.scenes.length > 0) {
        setPreviewSceneId(data.scenes[0].scene_id)
      }
      // Fetch transcript (soft-fail)
      fetch(`/api/video/videos/${id}/transcript`)
        .then((r) => (r.ok ? r.json() : null))
        .then((t) => {
          if (t?.segments) setTranscriptSegments(t.segments)
        })
        .catch(() => {})
      // Fetch valid tags
      fetch('/api/video/tags')
        .then((r) => (r.ok ? r.json() : []))
        .then(setValidTags)
        .catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const goBack = () => {
    setView('list')
    setResult(null)
    setPreviewSceneId(null)
    setPreviewSegmentId(null)
    setTranscriptSegments(null)
    clearSelection()
    setError(null)
  }

  // ── Render: progress bar ──────────────────────────────────────────────

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

  // ── Render: Level 1 — Video hub ───────────────────────────────────────

  if (view === 'list') {
    return (
      <div>
        <PageHeader
          title="Ingest & Segment"
          description="Stage 1 — probe duration (ffprobe), detect scene boundaries (PySceneDetect ContentDetector), extract start/mid/end keyframes per scene (ffmpeg)."
        />

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h3 className="text-sm font-medium text-text-primary mb-4">
              Run Ingest
            </h3>
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
                    No videos found in public/data/source/videos/. Drop one in
                    or type any path manually.
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

              <Button
                onClick={runIngest}
                disabled={isRunning}
                size="lg"
                className="w-full"
              >
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
                Nothing ingested yet. Run Stage 1 above to create the first
                entry.
              </p>
            ) : (
              <ul className="space-y-1">
                {videos.map((v) => (
                  <li key={v.video_id}>
                    <button
                      type="button"
                      onClick={() => openVideo(v.video_id)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md text-sm hover:bg-white/5 transition-colors group"
                    >
                      <span className="font-mono text-xs text-text-primary group-hover:text-maize truncate">
                        {v.video_id}
                      </span>
                      <span className="text-xs text-text-dim shrink-0 flex items-center gap-2">
                        {v.scene_count ?? '—'} scenes ·{' '}
                        <span
                          className={
                            v.status === 'completed'
                              ? 'text-teal'
                              : 'text-text-dim'
                          }
                        >
                          {v.status ?? 'unknown'}
                        </span>
                        <span className="text-text-dim opacity-0 group-hover:opacity-100 transition-opacity">
                          →
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    )
  }

  // ── Render: Level 2 — Scene browser ───────────────────────────────────

  if (!result) return null

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-4 mb-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={goBack}
            className="text-text-muted hover:text-text-primary text-sm shrink-0"
            title="Back to video list"
          >
            ← Back
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-text-primary truncate">
              {result.video_id}
            </h2>
            <p className="text-xs text-text-dim mt-0.5">
              {result.scene_count} scenes
              {result.raw_scene_count != null &&
                result.raw_scene_count !== result.scene_count && (
                  <span>
                    {' '}
                    (from {result.raw_scene_count} raw)
                  </span>
                )}
              {pendingMergeCount > 0 && (
                <span className="text-maize">
                  {' · '}
                  {pendingMergeCount} pending
                </span>
              )}
              {result.segments && result.segments.length > 0 && (
                <span className="text-teal">
                  {' · '}
                  {result.segments.filter((c) => c.type === 'content').length}{' '}
                  segments
                </span>
              )}
              {' · '}{fmtTime(result.duration)}
              {result.detector && (
                <>
                  {' · '}
                  {result.detector.name} ({result.detector.threshold})
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {pendingMergeCount > 0 && (
            <Button onClick={applyAllMerges} variant="secondary" size="sm">
              Apply {pendingMergeCount} merge
              {pendingMergeCount === 1 ? '' : 's'}
            </Button>
          )}
          {result.segments && result.segments.length > 0 ? (
            <Button onClick={clearSegments} variant="secondary" size="sm">
              Clear Segments
            </Button>
          ) : (
            <Button
              onClick={runDetectSegments}
              disabled={detectingSegments}
              variant="secondary"
              size="sm"
            >
              {detectingSegments ? 'Detecting…' : 'Detect Segments'}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="text-xs text-coral break-words mb-3 shrink-0">{error}</p>
      )}

      {/* Filter bar */}
      <div className="shrink-0 mb-3 flex items-center gap-3 flex-wrap">
        <span className="text-xs text-text-muted">Duration:</span>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={durationMin}
            onChange={(e) => setDurationMin(e.target.value)}
            placeholder="min"
            min={0}
            step={1}
            className="w-16 bg-bg3 border border-white/10 rounded px-2 py-1 text-xs text-text-primary font-mono tabular-nums placeholder:text-text-dim/50 focus:border-maize/50 focus:outline-none"
          />
          <span className="text-text-dim text-xs">–</span>
          <input
            type="number"
            value={durationMax}
            onChange={(e) => setDurationMax(e.target.value)}
            placeholder="max"
            min={0}
            step={1}
            className="w-16 bg-bg3 border border-white/10 rounded px-2 py-1 text-xs text-text-primary font-mono tabular-nums placeholder:text-text-dim/50 focus:border-maize/50 focus:outline-none"
          />
          <span className="text-xs text-text-dim">sec</span>
        </div>
        {segmentBySceneId.size > 0 && (
          <>
            <span className="text-xs text-text-muted ml-2">Segment:</span>
            <div className="flex items-center gap-0.5 bg-bg3 border border-white/10 rounded overflow-hidden">
              {(['all', 'content', 'boundary'] as const).map((val) => {
                const count =
                  val === 'all'
                    ? result.segments?.length ?? 0
                    : result.segments?.filter((c) => c.type === val).length ?? 0
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setSegmentFilter(val)}
                    className={`px-2 py-1 text-xs capitalize ${
                      segmentFilter === val
                        ? 'bg-white/10 text-text-primary'
                        : 'text-text-dim hover:text-text-muted'
                    }`}
                  >
                    {val}{' '}
                    <span className="tabular-nums opacity-60">{count}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
        {(hasDurationFilter || segmentFilter !== 'all') && (
          <>
            <span className="text-xs text-maize tabular-nums">
              {filteredScenes?.length ?? 0} / {result.scenes.length} scenes
            </span>
            <button
              type="button"
              onClick={() => {
                setDurationMin('')
                setDurationMax('')
                setSegmentFilter('all')
              }}
              className="text-xs text-text-dim hover:text-text-primary"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {/* Two-column layout */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: Scene list */}
        <div className="flex flex-col w-[55%] min-w-0">
          <div className="flex-1 overflow-y-auto space-y-1 pr-1">
            {(filteredScenes ?? result.scenes).map((scene) => {
              const isSelected = selectedScenes.has(scene.scene_id)
              const isPreviewing = previewSceneId === scene.scene_id
              const isMerged = (scene.merged_from?.length ?? 0) > 0
              const isPending = isMerged && scene.merge_status === 'pending'
              const isCommitted = isMerged && scene.merge_status !== 'pending'
              const firstKf = scene.keyframes[0]
              const hasBlackSlug = scene.tags?.includes('black_slug')

              // Segment header: render before the first scene in each segment
              const segment =segmentBySceneId.get(scene.scene_id)
              const isFirstInSegment =
                segment && segment.scene_ids[0] === scene.scene_id
              const isCollapsed =
                segment && collapsedSegments.has(segment.segment_id)

              // If this scene's segment is collapsed and it's not the first scene, skip
              if (segment && !isFirstInSegment && isCollapsed) return null

              return (
                <div key={scene.scene_id}>
                  {/* Segment header */}
                  {isFirstInSegment && segment && (<>
                    <div
                      className={`flex items-center gap-2 px-2 py-1.5 mt-2 mb-1 rounded-md border cursor-pointer transition-colors ${
                        previewSegmentId === segment.segment_id
                          ? 'ring-1 ring-maize/40 '
                          : ''
                      }${
                        segment.type === 'boundary'
                          ? 'border-white/5 bg-white/[0.02] hover:bg-white/[0.04]'
                          : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.06]'
                      }`}
                      onClick={() => {
                        toggleSegmentCollapsed(segment.segment_id)
                        setPreviewSegmentId(segment.segment_id)
                        setPreviewSceneId(null)
                      }}
                    >
                      <span className="text-text-dim text-[10px] leading-none shrink-0 w-4 text-center">
                        {isCollapsed ? '▸' : '▾'}
                      </span>
                      {editingSegmentId === segment.segment_id ? (
                        <input
                          type="text"
                          value={editingSegmentName}
                          onChange={(e) =>
                            setEditingSegmentName(e.target.value)
                          }
                          onBlur={commitSegmentRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitSegmentRename()
                            if (e.key === 'Escape')
                              setEditingSegmentId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                          className="text-text-primary bg-bg3 border border-maize/50 rounded px-1.5 py-0.5 text-xs min-w-0 flex-1 focus:outline-none"
                        />
                      ) : (
                        <span
                          className="text-xs font-medium text-text-primary truncate flex-1 cursor-text"
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            setEditingSegmentId(segment.segment_id)
                            setEditingSegmentName(segment.name)
                          }}
                          title="Double-click to rename"
                        >
                          {segment.name}
                        </span>
                      )}
                      <span className="text-[10px] text-text-dim font-mono shrink-0">
                        {segment.segment_id.split('_').pop()}
                      </span>
                      <span
                        className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${
                          segment.type === 'boundary'
                            ? 'bg-white/5 text-text-dim'
                            : 'bg-teal/10 text-teal'
                        }`}
                      >
                        {segment.type}
                      </span>
                      <span className="text-[10px] text-text-dim shrink-0 tabular-nums">
                        {segment.scene_ids.length} scene
                        {segment.scene_ids.length === 1 ? '' : 's'}
                        {' · '}
                        {fmtTime(segment.start)}→{fmtTime(segment.end)}
                      </span>
                      {segment.vlm_analysis && (
                        <span className="shrink-0 w-2 h-2 rounded-full bg-violet-400" title={segment.vlm_analysis.summary} />
                      )}
                      {segment.type === 'content' && (
                        <button
                          type="button"
                          title="VLM Analyze"
                          onClick={(e) => {
                            e.stopPropagation()
                            setVlmPromptSegmentId(
                              vlmPromptSegmentId === segment.segment_id
                                ? null
                                : segment.segment_id,
                            )
                          }}
                          className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                            vlmRunning === segment.segment_id
                              ? 'bg-violet-500/20 text-violet-300 animate-pulse'
                              : vlmPromptSegmentId === segment.segment_id
                                ? 'bg-violet-500/20 text-violet-300'
                                : 'bg-white/5 text-text-dim hover:text-violet-300 hover:bg-violet-500/10'
                          }`}
                          disabled={vlmRunning !== null}
                        >
                          {vlmRunning === segment.segment_id ? '...' : '✦'}
                        </button>
                      )}
                    </div>
                    {/* VLM prompt editor */}
                    {vlmPromptSegmentId === segment.segment_id && (
                      <div
                        className="mx-2 mb-1 p-2 rounded-md border border-violet-500/20 bg-violet-500/5 space-y-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <textarea
                          value={vlmPrompt}
                          onChange={(e) => setVlmPrompt(e.target.value)}
                          rows={3}
                          className="w-full bg-bg3 border border-white/10 rounded px-2 py-1.5 text-xs text-text-primary resize-y focus:outline-none focus:border-violet-500/40"
                          placeholder="Enter analysis prompt..."
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => runVlmAnalysis(segment.segment_id)}
                            disabled={vlmRunning !== null || !vlmPrompt.trim()}
                            className="px-3 py-1 rounded text-xs font-medium bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {vlmRunning === segment.segment_id
                              ? 'Analyzing...'
                              : 'Run VLM'}
                          </button>
                          <span className="text-[10px] text-text-dim">
                            gemma4:e4b via Ollama
                          </span>
                          <button
                            type="button"
                            onClick={() => setVlmPromptSegmentId(null)}
                            className="ml-auto text-[10px] text-text-dim hover:text-text-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </>)}

                  {/* Scene row (skip if collapsed) */}
                  {!isCollapsed && (
                    <div
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer transition-colors ${
                        isPreviewing
                          ? 'bg-white/8 ring-1 ring-maize/40'
                          : 'hover:bg-white/4'
                      } ${isSelected ? 'ring-1 ring-maize/60' : ''}`}
                      onClick={() => {
                        setPreviewSceneId(scene.scene_id)
                        setPreviewSegmentId(null)
                      }}
                    >
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          /* handled by onClick */
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSelectScene(scene.scene_id, e.shiftKey)
                        }}
                        className="accent-maize cursor-pointer shrink-0"
                        title="Select (shift-click for range)"
                      />

                      {/* Thumbnail */}
                      {firstKf ? (
                        <img
                          src={keyframeUrl(result.video_id, firstKf)}
                          alt=""
                          loading="lazy"
                          className="w-12 h-8 object-cover rounded border border-white/10 bg-black shrink-0"
                        />
                      ) : (
                        <div className="w-12 h-8 rounded border border-white/10 bg-black shrink-0" />
                      )}

                      {/* Scene info */}
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        {editingSceneId === scene.scene_id ? (
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename()
                              if (e.key === 'Escape') cancelEditing()
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                            className="font-mono text-text-primary bg-bg3 border border-maize/50 rounded px-1.5 py-0.5 text-xs min-w-0 flex-1 focus:outline-none"
                          />
                        ) : (
                          <span
                            className="font-mono text-text-primary truncate"
                            onDoubleClick={(e) => {
                              e.stopPropagation()
                              startEditing(scene.scene_id)
                            }}
                            title="Double-click to rename"
                          >
                            {scene.scene_id}
                          </span>
                        )}
                        {isMerged && (
                          <span
                            className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${
                              isCommitted
                                ? 'bg-teal/15 text-teal'
                                : 'bg-maize/15 text-maize'
                            }`}
                            title={
                              isCommitted
                                ? 'Committed — re-run scene detection to reset'
                                : 'Pending — click ✕ to undo'
                            }
                          >
                            {isCommitted ? 'merged' : 'pending'} ×
                            {scene.merged_from!.length}
                          </span>
                        )}
                        {hasBlackSlug && (
                          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-white/5 text-text-dim">
                            black slug
                          </span>
                        )}
                      </div>

                      {/* Time + duration */}
                      {editingTimeSceneId === scene.scene_id ? (
                        <input
                          type="text"
                          value={editingTimeValue}
                          onChange={(e) => setEditingTimeValue(e.target.value)}
                          onBlur={commitTimeRange}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitTimeRange()
                            if (e.key === 'Escape')
                              setEditingTimeSceneId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                          className="shrink-0 w-28 bg-bg3 border border-maize/50 rounded px-1.5 py-0.5 text-xs text-text-primary font-mono tabular-nums focus:outline-none"
                        />
                      ) : (
                        <span
                          className="text-text-muted shrink-0 tabular-nums cursor-text"
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            startEditingTime(
                              scene.scene_id,
                              scene.start,
                              scene.end,
                            )
                          }}
                          title="Double-click to edit time range"
                        >
                          {fmtTime(scene.start)}→{fmtTime(scene.end)}
                        </span>
                      )}
                      <span className="text-text-dim shrink-0 w-8 text-right tabular-nums">
                        {scene.duration != null
                          ? `${scene.duration.toFixed(0)}s`
                          : ''}
                      </span>

                      {/* Unmerge button */}
                      {isPending && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            unmergeGroup(scene.scene_id)
                          }}
                          className="shrink-0 text-text-dim hover:text-coral px-1 text-sm leading-none"
                          title="Unmerge"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Merge action bar — sticky at bottom of scene list */}
          {selectionInfo && (
            <div className="shrink-0 mt-2 bg-bg2/95 backdrop-blur border border-white/10 rounded-md px-3 py-2 flex items-center gap-3">
              <div className="text-xs flex-1 min-w-0">
                <div className="text-text-primary">
                  {selectionInfo.count} scene
                  {selectionInfo.count === 1 ? '' : 's'} selected
                  <span className="text-text-dim">
                    {' · '}
                    {fmtTime(selectionInfo.start)} →{' '}
                    {fmtTime(selectionInfo.end)}{' '}
                    ({(selectionInfo.end - selectionInfo.start).toFixed(1)}s)
                  </span>
                </div>
                {!selectionInfo.contiguous && (
                  <div className="text-coral text-[11px] mt-0.5">
                    Selection is not contiguous — pick adjacent scenes only.
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-text-muted hover:text-text-primary px-2 py-1"
              >
                Clear
              </button>
              <Button
                onClick={mergeSelected}
                disabled={
                  merging || !selectionInfo.contiguous || selectionInfo.count < 2
                }
                size="sm"
              >
                {merging
                  ? 'Merging…'
                  : `Merge ${selectionInfo.count} scenes`}
              </Button>
            </div>
          )}
        </div>

        {/* Right: Preview panel */}
        <div className="w-[45%] shrink-0 flex flex-col min-h-0">
          {previewSegment ? (() => {
            // Segment preview mode
            const chScenes = previewSegment.scene_ids
              .map((sid) => result.scenes.find((s) => s.scene_id === sid))
              .filter(Boolean) as Scene[]
            const allKeyframes = chScenes
              .flatMap((s) => s.keyframes)
              .sort((a, b) => a.timestamp - b.timestamp)
            // Check contiguity
            const sceneIds = result.scenes.map((s) => s.scene_id)
            const positions = previewSegment.scene_ids
              .map((sid) => sceneIds.indexOf(sid))
              .filter((i) => i !== -1)
              .sort((a, b) => a - b)
            const isContiguous =
              positions.length > 0 &&
              positions[positions.length - 1] - positions[0] === positions.length - 1
            const chDuration = previewSegment.end - previewSegment.start

            return (
              <div className="flex-1 overflow-y-auto space-y-4 bg-bg3/50 rounded-lg p-4 border border-white/5">
                {videoUrl ? (
                  <ScenePlayer
                    key={`ch-${previewSegment.segment_id}`}
                    src={videoUrl}
                    sceneStart={previewSegment.start}
                    sceneEnd={previewSegment.end}
                    transcriptSegments={transcriptSegments}
                  />
                ) : (
                  <div className="w-full aspect-video rounded border border-white/10 bg-black flex items-center justify-center">
                    <p className="text-[11px] text-text-dim italic">
                      Source video not under public/ — preview unavailable.
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <h3 className="text-sm font-medium text-text-primary">
                    {previewSegment.name}
                  </h3>
                  <p className="text-xs text-text-dim">
                    {fmtTime(previewSegment.start)} → {fmtTime(previewSegment.end)}
                    <span> · {chDuration.toFixed(1)}s</span>
                    {' · '}{previewSegment.scene_ids.length} scene
                    {previewSegment.scene_ids.length === 1 ? '' : 's'}
                    {' · '}{allKeyframes.length} keyframe
                    {allKeyframes.length === 1 ? '' : 's'}
                  </p>
                  <div className="flex gap-1.5 flex-wrap">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${
                        previewSegment.type === 'boundary'
                          ? 'bg-white/5 text-text-dim'
                          : 'bg-teal/10 text-teal'
                      }`}
                    >
                      {previewSegment.type}
                    </span>
                    {!isContiguous && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-coral/15 text-coral">
                        non-contiguous
                      </span>
                    )}
                  </div>
                </div>

                {/* Transcript toggle + editor */}
                {transcriptSegments && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowTranscript((v) => !v)}
                      className={`text-xs px-2 py-1 rounded border ${
                        showTranscript
                          ? 'border-maize/40 bg-maize/10 text-maize'
                          : 'border-white/10 text-text-dim hover:text-text-muted'
                      }`}
                    >
                      Transcript
                    </button>
                    {showTranscript && (
                      <div className="mt-2 border-t border-white/5 pt-2">
                        <TranscriptPanel
                          segments={transcriptSegments.filter(
                            (s) =>
                              s.end > previewSegment.start &&
                              s.start < previewSegment.end,
                          )}
                          videoId={result.video_id}
                          onUpdate={setTranscriptSegments}
                          onSeek={(t) => {
                            const v = document.querySelector('video')
                            if (v) v.currentTime = t
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* VLM Analysis toggle + display */}
                {previewSegment.type === 'content' && (
                  <div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setShowVlmAnalysis((v) => !v)}
                        className={`text-xs px-2 py-1 rounded border ${
                          showVlmAnalysis
                            ? 'border-violet-400/40 bg-violet-500/10 text-violet-300'
                            : 'border-white/10 text-text-dim hover:text-text-muted'
                        }`}
                      >
                        VLM Analysis
                        {previewSegment.vlm_analysis && ' ✦'}
                      </button>
                      {!previewSegment.vlm_analysis && !showVlmAnalysis && (
                        <button
                          type="button"
                          onClick={() => {
                            setVlmPromptSegmentId(previewSegment.segment_id)
                            setShowVlmAnalysis(true)
                          }}
                          className="text-xs px-2 py-1 rounded border border-violet-500/20 text-violet-300/60 hover:text-violet-300 hover:bg-violet-500/10 transition-colors"
                        >
                          Analyze
                        </button>
                      )}
                    </div>
                    {showVlmAnalysis && (
                      <div className="mt-2 border-t border-white/5 pt-2 space-y-3">
                        {previewSegment.vlm_analysis ? (
                          <>
                            <p className="text-xs text-text-primary whitespace-pre-wrap leading-relaxed">
                              {previewSegment.vlm_analysis.full_analysis}
                            </p>
                            <details className="text-[10px] text-text-dim">
                              <summary className="cursor-pointer hover:text-text-muted">
                                {previewSegment.vlm_analysis.model} · {previewSegment.vlm_analysis.analyzed_at}
                              </summary>
                              <p className="mt-1 pl-3 border-l border-white/5 text-text-dim whitespace-pre-wrap">
                                {previewSegment.vlm_analysis.prompt}
                              </p>
                            </details>
                            <button
                              type="button"
                              onClick={() =>
                                setVlmPromptSegmentId(
                                  vlmPromptSegmentId === previewSegment.segment_id
                                    ? null
                                    : previewSegment.segment_id,
                                )
                              }
                              className="text-[10px] px-2 py-0.5 rounded border border-violet-500/20 text-violet-300/60 hover:text-violet-300 transition-colors"
                            >
                              Re-analyze
                            </button>
                            {vlmPromptSegmentId === previewSegment.segment_id && (
                              <div className="p-2 rounded-md border border-violet-500/20 bg-violet-500/5 space-y-2">
                                <textarea
                                  value={vlmPrompt}
                                  onChange={(e) => setVlmPrompt(e.target.value)}
                                  rows={3}
                                  className="w-full bg-bg3 border border-white/10 rounded px-2 py-1.5 text-xs text-text-primary resize-y focus:outline-none focus:border-violet-500/40"
                                />
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      runVlmAnalysis(previewSegment.segment_id)
                                    }
                                    disabled={vlmRunning !== null || !vlmPrompt.trim()}
                                    className="px-3 py-1 rounded text-xs font-medium bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                  >
                                    {vlmRunning === previewSegment.segment_id
                                      ? 'Analyzing...'
                                      : 'Run VLM'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setVlmPromptSegmentId(null)}
                                    className="text-[10px] text-text-dim hover:text-text-muted"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-xs text-text-dim italic">
                              No analysis yet. Run VLM to analyze this segment.
                            </p>
                            {vlmPromptSegmentId !== previewSegment.segment_id && (
                              <button
                                type="button"
                                onClick={() =>
                                  setVlmPromptSegmentId(previewSegment.segment_id)
                                }
                                className="px-3 py-1 rounded text-xs font-medium bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-colors"
                              >
                                Analyze with VLM
                              </button>
                            )}
                            {vlmPromptSegmentId === previewSegment.segment_id && (
                              <div className="p-2 rounded-md border border-violet-500/20 bg-violet-500/5 space-y-2">
                                <textarea
                                  value={vlmPrompt}
                                  onChange={(e) => setVlmPrompt(e.target.value)}
                                  rows={3}
                                  className="w-full bg-bg3 border border-white/10 rounded px-2 py-1.5 text-xs text-text-primary resize-y focus:outline-none focus:border-violet-500/40"
                                />
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      runVlmAnalysis(previewSegment.segment_id)
                                    }
                                    disabled={vlmRunning !== null || !vlmPrompt.trim()}
                                    className="px-3 py-1 rounded text-xs font-medium bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                  >
                                    {vlmRunning === previewSegment.segment_id
                                      ? 'Analyzing...'
                                      : 'Run VLM'}
                                  </button>
                                  <span className="text-[10px] text-text-dim">
                                    gemma4:e4b via Ollama
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setVlmPromptSegmentId(null)}
                                    className="ml-auto text-[10px] text-text-dim hover:text-text-muted"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {allKeyframes.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {allKeyframes.map((kf) => (
                      <figure
                        key={kf.path}
                        className="flex flex-col items-center gap-1"
                      >
                        <img
                          src={keyframeUrl(result.video_id, kf)}
                          alt=""
                          loading="lazy"
                          className="w-full rounded border border-white/10 bg-black"
                        />
                        <figcaption className="text-[10px] text-text-dim font-mono">
                          {kf.role ?? `frame ${kf.index}`} ·{' '}
                          {fmtTime(kf.timestamp)}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                )}
              </div>
            )
          })() : previewScene ? (
            <div className="flex-1 overflow-y-auto space-y-4 bg-bg3/50 rounded-lg p-4 border border-white/5">
              {/* Video player */}
              {videoUrl ? (
                <ScenePlayer
                  key={`${previewScene.scene_id}-${previewScene.start}-${previewScene.end}`}
                  src={videoUrl}
                  sceneStart={previewScene.start}
                  sceneEnd={previewScene.end}
                  transcriptSegments={transcriptSegments}
                  onTimeUpdate={setCurrentPlaybackTime}
                />
              ) : (
                <div className="w-full aspect-video rounded border border-white/10 bg-black flex items-center justify-center">
                  <p className="text-[11px] text-text-dim italic">
                    Source video not under public/ — preview unavailable.
                  </p>
                </div>
              )}

              {/* Scene metadata */}
              <div className="space-y-1">
                <h3 className="text-sm font-medium text-text-primary font-mono">
                  {previewScene.scene_id}
                </h3>
                <p className="text-xs text-text-dim">
                  {fmtTime(previewScene.start)} → {fmtTime(previewScene.end)}
                  {previewScene.duration != null && (
                    <span> · {previewScene.duration.toFixed(1)}s</span>
                  )}
                  {' · '}{previewScene.keyframes.length} keyframe
                  {previewScene.keyframes.length === 1 ? '' : 's'}
                  {previewScene.merged_from && (
                    <span className="text-teal">
                      {' · '}merged from {previewScene.merged_from.length} scenes
                    </span>
                  )}
                </p>
                {/* Tags (editable) */}
                <div className="flex gap-1.5 flex-wrap items-center">
                  {(previewScene.tags ?? []).map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-white/5 text-text-dim group/tag"
                    >
                      {tag.replace(/_/g, ' ')}
                      <button
                        type="button"
                        onClick={async () => {
                          const newTags = (previewScene.tags ?? []).filter(
                            (t) => t !== tag,
                          )
                          try {
                            const res = await fetch(
                              `/api/video/videos/${result.video_id}/scenes/tags`,
                              {
                                method: 'PATCH',
                                headers: {
                                  'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                  scene_id: previewScene.scene_id,
                                  tags: newTags,
                                }),
                              },
                            )
                            if (res.ok) setResult(await res.json())
                          } catch {}
                        }}
                        className="text-text-dim hover:text-coral text-[9px] leading-none opacity-0 group-hover/tag:opacity-100 transition-opacity"
                        title="Remove tag"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {(() => {
                    const existing = previewScene.tags ?? []
                    const available = validTags.filter(
                      (t) => !existing.includes(t),
                    )
                    if (available.length === 0) return null
                    return (
                      <select
                        value=""
                        onChange={async (e) => {
                          const val = e.target.value
                          if (!val) return
                          try {
                            const res = await fetch(
                              `/api/video/videos/${result.video_id}/scenes/tags`,
                              {
                                method: 'PATCH',
                                headers: {
                                  'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                  scene_id: previewScene.scene_id,
                                  tags: [...existing, val],
                                }),
                              },
                            )
                            if (res.ok) setResult(await res.json())
                          } catch {}
                        }}
                        className="bg-bg3 border border-white/10 rounded text-[10px] text-text-dim px-1 py-0.5 focus:border-maize/50 focus:outline-none cursor-pointer"
                      >
                        <option value="">+ tag</option>
                        {available.map((t) => (
                          <option key={t} value={t}>
                            {t.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                    )
                  })()}
                </div>
                {/* Segment info */}
                {(() => {
                  const ch = segmentBySceneId.get(previewScene.scene_id)
                  if (!ch) return null
                  return (
                    <p className="text-xs text-text-dim">
                      {ch.name}
                      <span className={ch.type === 'boundary' ? 'text-text-dim' : 'text-teal'}>
                        {' · '}{ch.type}
                      </span>
                    </p>
                  )
                })()}
              </div>

              {/* Trim buttons */}
              {currentPlaybackTime != null &&
                currentPlaybackTime > previewScene.start &&
                currentPlaybackTime < previewScene.end && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        setError(null)
                        try {
                          const res = await fetch(
                            `/api/video/videos/${result.video_id}/scenes/trim`,
                            {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                scene_id: previewScene.scene_id,
                                trim_point: currentPlaybackTime,
                                direction: 'keep_before',
                              }),
                            },
                          )
                          if (!res.ok) {
                            const err = await res
                              .json()
                              .catch(() => ({ detail: 'Trim failed' }))
                            throw new Error(err.detail || 'Trim failed')
                          }
                          setResult(await res.json())
                        } catch (e) {
                          setError(
                            e instanceof Error ? e.message : String(e),
                          )
                        }
                      }}
                      className="text-xs px-2 py-1 rounded border border-white/10 text-text-dim hover:text-text-muted hover:border-white/20"
                    >
                      Trim to here ({fmtTime(currentPlaybackTime)})
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        setError(null)
                        try {
                          const res = await fetch(
                            `/api/video/videos/${result.video_id}/scenes/trim`,
                            {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                scene_id: previewScene.scene_id,
                                trim_point: currentPlaybackTime,
                                direction: 'keep_after',
                              }),
                            },
                          )
                          if (!res.ok) {
                            const err = await res
                              .json()
                              .catch(() => ({ detail: 'Trim failed' }))
                            throw new Error(err.detail || 'Trim failed')
                          }
                          setResult(await res.json())
                        } catch (e) {
                          setError(
                            e instanceof Error ? e.message : String(e),
                          )
                        }
                      }}
                      className="text-xs px-2 py-1 rounded border border-white/10 text-text-dim hover:text-text-muted hover:border-white/20"
                    >
                      Trim from here ({fmtTime(currentPlaybackTime)})
                    </button>
                  </div>
                )}

              {/* Transcript toggle + editor */}
              {transcriptSegments && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowTranscript((v) => !v)}
                    className={`text-xs px-2 py-1 rounded border ${
                      showTranscript
                        ? 'border-maize/40 bg-maize/10 text-maize'
                        : 'border-white/10 text-text-dim hover:text-text-muted'
                    }`}
                  >
                    Transcript
                  </button>
                  {showTranscript && (
                    <div className="mt-2 border-t border-white/5 pt-2">
                      <TranscriptPanel
                        segments={transcriptSegments.filter(
                          (s) =>
                            s.end > previewScene.start &&
                            s.start < previewScene.end,
                        )}
                        videoId={result.video_id}
                        onUpdate={setTranscriptSegments}
                        onSeek={(t) => {
                          const v = document.querySelector('video')
                          if (v) v.currentTime = t
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Keyframes grid */}
              {previewScene.keyframes.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {previewScene.keyframes.map((kf) => (
                    <figure
                      key={kf.path}
                      className="relative flex flex-col items-center gap-1 group/kf"
                    >
                      <div className="relative w-full">
                        <img
                          src={keyframeUrl(result.video_id, kf)}
                          alt={`${previewScene.scene_id} ${kf.role ?? kf.index}`}
                          loading="lazy"
                          className="w-full rounded border border-white/10 bg-black"
                        />
                        {previewScene.keyframes.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              deleteKeyframe(previewScene.scene_id, kf.path)
                            }
                            className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-text-dim hover:bg-coral hover:text-white flex items-center justify-center text-xs leading-none opacity-0 group-hover/kf:opacity-100 transition-opacity"
                            title="Remove keyframe"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      <figcaption className="text-[10px] text-text-dim font-mono">
                        {kf.role ?? `frame ${kf.index}`} ·{' '}
                        {fmtTime(kf.timestamp)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center bg-bg3/50 rounded-lg border border-white/5">
              <p className="text-sm text-text-dim">
                Click a scene or segment to preview
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
