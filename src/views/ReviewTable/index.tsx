import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import type { SourceItem, ClassifiedItem } from '../../lib/types'
import { GENRES, EVENT_TYPES } from '../../lib/constants'

interface MergedItem extends SourceItem {
  item_id: string
  classification?: ClassifiedItem
}

type ProcessedFilter = '' | 'processed' | 'unprocessed'

export function ReviewTable() {
  const [items, setItems] = useState<MergedItem[]>([])
  const [threads, setThreads] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [sorting, setSorting] = useState<SortingState>([])
  const [threadFilter, setThreadFilter] = useState<string>('')
  const [confidenceFilter, setConfidenceFilter] = useState<string>('')
  const [processedFilter, setProcessedFilter] = useState<ProcessedFilter>('')
  const [genreFilter, setGenreFilter] = useState<string>('')
  const [crypticFilter, setCrypticFilter] = useState(false)
  const [duplicatesFilter, setDuplicatesFilter] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showBaseline, setShowBaseline] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [editingItem, setEditingItem] = useState<MergedItem | null>(null)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  const handleSaveEdit = useCallback(async (itemId: string, updates: Partial<ClassifiedItem>) => {
    // Send each changed field as an edit to the backend
    const edits = Object.entries(updates).map(([field, newValue]) => {
      const original = items.find(i => i.item_id === itemId)?.classification
      return {
        item_id: itemId,
        field,
        old_value: original ? (original as Record<string, unknown>)[field] : null,
        new_value: newValue,
        timestamp: new Date().toISOString(),
      }
    })

    try {
      await fetch('/api/run/latest/edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      })
    } catch { /* offline — apply optimistically */ }

    // Optimistic local update
    setItems(prev => prev.map(item => {
      if (item.item_id !== itemId || !item.classification) return item
      return {
        ...item,
        classification: { ...item.classification, ...updates },
      }
    }))
    setEditingItem(null)
  }, [items])

  useEffect(() => {
    async function load() {
      try {
        const sourceRes = await fetch('/api/source/items')
        if (!sourceRes.ok) throw new Error('API unavailable')
        const sourceItems: SourceItem[] = await sourceRes.json()

        let classifications: ClassifiedItem[] = []
        try {
          const classRes = await fetch('/api/run/latest/classifications')
          if (classRes.ok) classifications = await classRes.json()
        } catch { /* no classifications yet */ }

        const classMap = new Map(classifications.map((c) => [c.item_id, c]))
        const merged = sourceItems.map((s) => {
          const id = `${s.container}-${s.item}`
          return { ...s, item_id: id, classification: classMap.get(id) }
        })
        setItems(merged)

        // Fetch dynamic thread list
        try {
          const threadsRes = await fetch('/api/run/latest/threads')
          if (threadsRes.ok) setThreads(await threadsRes.json())
        } catch { /* use empty list */ }
      } catch {
        try {
          const res = await fetch('/data/source/items.json')
          if (!res.ok) throw new Error()
          const sourceItems: SourceItem[] = await res.json()
          setItems(sourceItems.map((s) => ({ ...s, item_id: `${s.container}-${s.item}` })))
        } catch {
          setItems([])
        }
      }
      setLoading(false)
    }
    load()
  }, [])

  const processedCount = useMemo(() => items.filter((i) => i.classification).length, [items])
  const unprocessedCount = useMemo(() => items.filter((i) => !i.classification).length, [items])

  const duplicateIds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      counts.set(item.item_id, (counts.get(item.item_id) || 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id))
  }, [items])
  const duplicateCount = useMemo(() => items.filter((i) => duplicateIds.has(i.item_id)).length, [items, duplicateIds])

  const filteredItems = useMemo(() => {
    let result = items

    // Processed/unprocessed filter
    if (processedFilter === 'processed') {
      result = result.filter((item) => !!item.classification)
    } else if (processedFilter === 'unprocessed') {
      result = result.filter((item) => !item.classification)
    }

    // Thread filter
    if (threadFilter) {
      if (threadFilter === 'Unclassified') {
        result = result.filter((item) => {
          if (item.classification) return item.classification.threads.length === 0
          return item.thread === 'Unclassified'
        })
      } else {
        result = result.filter((item) => {
          if (item.classification) {
            return item.classification.threads.some((t) => t.name === threadFilter)
          }
          return item.thread === threadFilter
        })
      }
    }

    // Confidence filter
    if (confidenceFilter) {
      result = result.filter(
        (item) => item.classification?.threads.some((t) => t.confidence === confidenceFilter)
      )
    }

    // Genre filter
    if (genreFilter) {
      result = result.filter((item) => item.classification?.genre === genreFilter)
    }

    // Cryptic filter
    if (crypticFilter) {
      result = result.filter((item) => item.classification?.is_cryptic)
    }

    // Duplicates filter
    if (duplicatesFilter) {
      result = result.filter((item) => duplicateIds.has(item.item_id))
    }

    // Search by description
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase()
      result = result.filter((item) =>
        item.description?.toLowerCase().includes(query)
      )
    }

    return result
  }, [items, processedFilter, threadFilter, confidenceFilter, genreFilter, crypticFilter, duplicatesFilter, duplicateIds, searchQuery])

  const columns = useMemo<ColumnDef<MergedItem>[]>(
    () => [
      {
        id: 'status',
        header: '',
        size: 32,
        cell: ({ row }) => (
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              row.original.classification ? 'bg-teal' : 'bg-text-dim'
            }`}
            title={row.original.classification ? 'Processed' : 'Unprocessed'}
          />
        ),
      },
      {
        accessorKey: 'item_id',
        header: 'ID',
        size: 70,
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-text-dim">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: 'description',
        header: 'Description',
        size: 280,
        cell: ({ getValue }) => (
          <span className="text-sm">{getValue<string>()}</span>
        ),
      },
      {
        id: 'threads',
        header: 'Threads',
        size: 240,
        cell: ({ row }) => {
          const cls = row.original.classification
          if (cls && cls.threads.length > 0) {
            return (
              <div className="flex flex-wrap gap-1">
                {cls.threads.map((t) => (
                  <Badge key={t.name} label={t.name} />
                ))}
              </div>
            )
          }
          if (cls && cls.threads.length === 0) {
            return cls.proposed_thread ? (
              <span className="text-xs text-purple italic">{cls.proposed_thread}</span>
            ) : (
              <span className="text-xs text-text-dim italic">Unclassified</span>
            )
          }
          const kw = row.original.thread
          return kw && kw !== 'Unclassified' ? (
            <Badge label={kw} color="var(--color-text-dim)" />
          ) : (
            <span className="text-xs text-text-dim italic">—</span>
          )
        },
      },
      {
        id: 'confidence',
        header: 'Conf.',
        size: 60,
        cell: ({ row }) => {
          const top = row.original.classification?.threads[0]
          if (!top) return null
          const color =
            top.confidence === 'high'
              ? 'text-teal'
              : top.confidence === 'medium'
                ? 'text-amber'
                : 'text-coral'
          return <span className={`text-xs font-medium ${color}`}>{top.confidence}</span>
        },
      },
      {
        id: 'genre',
        header: 'Genre',
        size: 110,
        cell: ({ row }) => (
          <span className="text-xs text-text-muted">
            {row.original.classification?.genre || '—'}
          </span>
        ),
      },
      {
        id: 'entities',
        header: 'Entities',
        size: 80,
        cell: ({ row }) => {
          const e = row.original.classification?.entities
          if (!e) return null
          const count = (e.people?.length || 0) + (e.places?.length || 0) + (e.organizations?.length || 0) + (e.event_type ? 1 : 0)
          return count > 0 ? (
            <span className="text-xs text-text-muted font-mono">{count}</span>
          ) : null
        },
      },
      ...(showBaseline
        ? [
            {
              id: 'baseline',
              header: 'Keyword Baseline',
              size: 150,
              cell: ({ row }: { row: { original: MergedItem } }) => {
                const kw = row.original.thread
                const llm = row.original.classification?.threads[0]?.name
                const mismatch = llm && kw !== 'Unclassified' && llm !== kw
                return (
                  <span
                    className={`text-xs ${mismatch ? 'text-coral font-medium' : 'text-text-dim'}`}
                  >
                    {kw}
                  </span>
                )
              },
            } as ColumnDef<MergedItem>,
          ]
        : []),
    ],
    [showBaseline]
  )

  const table = useReactTable({
    data: filteredItems,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const { rows } = table.getRowModel()

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 44,
    overscan: 20,
  })

  if (loading) {
    return (
      <div>
        <PageHeader title="Review Table" />
        <div className="text-text-dim text-sm">Loading items...</div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div>
        <PageHeader title="Review Table" />
        <Card>
          <p className="text-sm text-text-dim">
            No items loaded. Start the Python backend server (<code className="font-mono text-xs text-text-muted">python pipeline/server.py</code>) to load data.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex gap-5 h-[calc(100vh-4rem)]">
      {/* Filter sidebar */}
      <Card className="w-52 shrink-0 overflow-y-auto">
        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
          Filters
        </h3>

        <div className="space-y-4">
          {/* Search by description */}
          <div>
            <label className="block text-xs text-text-dim mb-1">Search</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search descriptions..."
              className="w-full bg-bg3 border border-white/10 rounded-md px-2 py-1.5 text-xs text-text-primary placeholder:text-text-dim/50"
            />
          </div>

          {/* Processed status filter */}
          <div>
            <label className="block text-xs text-text-dim mb-1">Status</label>
            <select
              value={processedFilter}
              onChange={(e) => setProcessedFilter(e.target.value as ProcessedFilter)}
              className="w-full bg-bg3 border border-white/10 rounded-md px-2 py-1.5 text-xs text-text-primary"
            >
              <option value="">All items</option>
              <option value="processed">Processed ({processedCount.toLocaleString()})</option>
              <option value="unprocessed">Unprocessed ({unprocessedCount.toLocaleString()})</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-text-dim mb-1">Thread</label>
            <select
              value={threadFilter}
              onChange={(e) => setThreadFilter(e.target.value)}
              className="w-full bg-bg3 border border-white/10 rounded-md px-2 py-1.5 text-xs text-text-primary"
            >
              <option value="">All threads</option>
              {threads.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
              <option value="Unclassified">Unclassified</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-text-dim mb-1">Confidence</label>
            <select
              value={confidenceFilter}
              onChange={(e) => setConfidenceFilter(e.target.value)}
              className="w-full bg-bg3 border border-white/10 rounded-md px-2 py-1.5 text-xs text-text-primary"
            >
              <option value="">All</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-text-dim mb-1">Genre</label>
            <select
              value={genreFilter}
              onChange={(e) => setGenreFilter(e.target.value)}
              className="w-full bg-bg3 border border-white/10 rounded-md px-2 py-1.5 text-xs text-text-primary"
            >
              <option value="">All</option>
              <option value="reporter_package">Reporter Package</option>
              <option value="b_roll">B-Roll</option>
              <option value="interview">Interview</option>
              <option value="anchor_read">Anchor Read</option>
              <option value="live_shot">Live Shot</option>
              <option value="closer">Closer</option>
              <option value="sports_highlight">Sports Highlight</option>
              <option value="weather_segment">Weather Segment</option>
              <option value="editorial">Editorial</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={crypticFilter}
              onChange={(e) => setCrypticFilter(e.target.checked)}
              className="rounded"
            />
            Cryptic items only
          </label>

          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={duplicatesFilter}
              onChange={(e) => setDuplicatesFilter(e.target.checked)}
              className="rounded"
            />
            Duplicates only ({duplicateCount})
          </label>

          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={showBaseline}
              onChange={(e) => setShowBaseline(e.target.checked)}
              className="rounded"
            />
            Show keyword baseline
          </label>
        </div>

        <div className="mt-4 pt-3 border-t border-white/6 space-y-1">
          <p className="text-xs text-text-dim">
            Showing {filteredItems.length.toLocaleString()} / {items.length.toLocaleString()}
          </p>
          <div className="flex items-center gap-2 text-xs">
            <span className="inline-block w-2 h-2 rounded-full bg-teal" />
            <span className="text-text-dim">{processedCount.toLocaleString()} processed</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="inline-block w-2 h-2 rounded-full bg-text-dim" />
            <span className="text-text-dim">{unprocessedCount.toLocaleString()} unprocessed</span>
          </div>
        </div>
      </Card>

      {/* Table */}
      <div className="flex-1 min-w-0">
        <div
          ref={tableContainerRef}
          className="h-full overflow-auto rounded-xl border border-white/6"
        >
          <table className="w-full">
            <thead className="sticky top-0 bg-bg2 z-10">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-4 py-3 border-b border-white/6 cursor-pointer select-none hover:text-text-primary"
                      style={{ width: header.getSize() }}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: ' ↑',
                        desc: ' ↓',
                      }[header.column.getIsSorted() as string] ?? ''}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]
                const isProcessed = !!row.original.classification
                const isExpanded = expandedRow === row.original.item_id
                return (
                  <>
                    <tr
                      key={row.id}
                      className={`border-b border-white/4 hover:bg-white/3 cursor-pointer transition-colors ${
                        !isProcessed ? 'opacity-50' : ''
                      }`}
                      style={{ height: `${virtualRow.size}px` }}
                      onClick={() =>
                        setExpandedRow(isExpanded ? null : row.original.item_id)
                      }
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-4 py-2">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {isExpanded && isProcessed && (
                      <tr key={`${row.id}-detail`} className="bg-bg3/50">
                        <td colSpan={columns.length} className="px-6 py-4">
                          <ExpandedDetail item={row.original} onEdit={() => setEditingItem(row.original)} />
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editingItem && editingItem.classification && (
        <EditModal
          item={editingItem}
          threads={threads}
          onSave={(updates) => handleSaveEdit(editingItem.item_id, updates)}
          onClose={() => setEditingItem(null)}
        />
      )}
    </div>
  )
}

function ExpandedDetail({ item, onEdit }: { item: MergedItem; onEdit: () => void }) {
  const cls = item.classification
  if (!cls) return null

  return (
    <div className="grid grid-cols-2 gap-4 text-xs relative">
      <div className="absolute top-0 right-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => { e.stopPropagation(); onEdit() }}
        >
          Edit
        </Button>
      </div>
      <div>
        <h4 className="text-text-muted uppercase tracking-wider mb-2 font-medium">Entities</h4>
        {cls.entities.people.length > 0 && (
          <div className="mb-1">
            <span className="text-text-dim">People: </span>
            <span className="text-text-primary">{cls.entities.people.join(', ')}</span>
          </div>
        )}
        {cls.entities.places.length > 0 && (
          <div className="mb-1">
            <span className="text-text-dim">Places: </span>
            <span className="text-text-primary">{cls.entities.places.join(', ')}</span>
          </div>
        )}
        {cls.entities.organizations.length > 0 && (
          <div className="mb-1">
            <span className="text-text-dim">Orgs: </span>
            <span className="text-text-primary">{cls.entities.organizations.join(', ')}</span>
          </div>
        )}
        {cls.entities.event_type && (
          <div className="mb-1">
            <span className="text-text-dim">Event: </span>
            <span className="text-text-primary">{cls.entities.event_type}</span>
          </div>
        )}
        {cls.entities.people.length === 0 && cls.entities.places.length === 0 &&
         cls.entities.organizations.length === 0 && !cls.entities.event_type && (
          <span className="text-text-dim italic">No entities extracted</span>
        )}
      </div>
      <div>
        <h4 className="text-text-muted uppercase tracking-wider mb-2 font-medium">Details</h4>
        <div className="mb-1">
          <span className="text-text-dim">Genre: </span>
          <span className="text-text-primary">{cls.genre}</span>
        </div>
        <div className="mb-1">
          <span className="text-text-dim">Cryptic: </span>
          <span className={cls.is_cryptic ? 'text-coral' : 'text-text-primary'}>
            {cls.is_cryptic ? 'Yes' : 'No'}
          </span>
        </div>
        {cls.decode_note && (
          <div className="mb-1">
            <span className="text-text-dim">Decode: </span>
            <span className="text-teal">{cls.decode_note}</span>
          </div>
        )}
        {cls.proposed_thread && (
          <div className="mb-1">
            <span className="text-text-dim">Proposed: </span>
            <span className="text-purple">{cls.proposed_thread}</span>
          </div>
        )}
        <div className="mt-2 pt-2 border-t border-white/6">
          <span className="text-text-dim">Notes: </span>
          <span className="text-text-muted">{item.notes || '—'}</span>
        </div>
        <div className="mb-1">
          <span className="text-text-dim">Date: </span>
          <span className="text-text-muted">{item.date || '—'}</span>
        </div>
      </div>
    </div>
  )
}

function EditModal({
  item,
  threads,
  onSave,
  onClose,
}: {
  item: MergedItem
  threads: string[]
  onSave: (updates: Partial<ClassifiedItem>) => void
  onClose: () => void
}) {
  const cls = item.classification!
  const [genre, setGenre] = useState(cls.genre)
  const [isCryptic, setIsCryptic] = useState(cls.is_cryptic)
  const [decodeNote, setDecodeNote] = useState(cls.decode_note || '')
  const [proposedThread, setProposedThread] = useState(cls.proposed_thread || '')
  const [assignedThreads, setAssignedThreads] = useState(cls.threads.map(t => t.name))
  const [people, setPeople] = useState(cls.entities.people.join(', '))
  const [places, setPlaces] = useState(cls.entities.places.join(', '))
  const [organizations, setOrganizations] = useState(cls.entities.organizations.join(', '))
  const [eventType, setEventType] = useState(cls.entities.event_type || '')

  const handleSubmit = () => {
    const parseList = (s: string) => s.split(',').map(v => v.trim()).filter(Boolean)
    onSave({
      genre,
      is_cryptic: isCryptic,
      decode_note: decodeNote || null,
      proposed_thread: proposedThread || null,
      threads: assignedThreads.map(name => {
        const existing = cls.threads.find(t => t.name === name)
        return existing || { name, confidence: 'high' as const }
      }),
      entities: {
        people: parseList(people),
        places: parseList(places),
        organizations: parseList(organizations),
        event_type: (eventType || null) as ClassifiedItem['entities']['event_type'],
      },
    })
  }

  const toggleThread = (name: string) => {
    setAssignedThreads(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    )
  }

  const inputClass = 'w-full bg-bg3 border border-white/10 rounded-md px-3 py-1.5 text-sm text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-teal/50'
  const labelClass = 'block text-xs text-text-dim mb-1 font-medium'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg2 border border-white/10 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/6">
          <div>
            <h2 className="text-sm font-medium text-text-primary">Edit Classification</h2>
            <p className="text-xs text-text-dim mt-0.5">
              Item {item.item_id} — {item.description?.slice(0, 60)}{(item.description?.length || 0) > 60 ? '...' : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-primary text-lg leading-none cursor-pointer">
            ×
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Threads */}
          <div>
            <label className={labelClass}>Threads</label>
            <div className="flex flex-wrap gap-1.5">
              {threads.map(t => (
                <button
                  key={t}
                  onClick={() => toggleThread(t)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors cursor-pointer ${
                    assignedThreads.includes(t)
                      ? 'bg-teal/20 border-teal/40 text-teal'
                      : 'border-white/10 text-text-dim hover:border-white/20'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Genre */}
            <div>
              <label className={labelClass}>Genre</label>
              <select value={genre} onChange={e => setGenre(e.target.value as typeof genre)} className={inputClass}>
                {GENRES.map(g => <option key={g} value={g}>{g.replace(/_/g, ' ')}</option>)}
              </select>
            </div>

            {/* Event Type */}
            <div>
              <label className={labelClass}>Event Type</label>
              <select value={eventType} onChange={e => setEventType(e.target.value)} className={inputClass}>
                <option value="">None</option>
                {EVENT_TYPES.map(et => <option key={et} value={et}>{et.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          </div>

          {/* Cryptic */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={isCryptic}
                onChange={e => setIsCryptic(e.target.checked)}
                className="rounded"
              />
              Cryptic description
            </label>
          </div>

          {/* Decode Note */}
          {isCryptic && (
            <div>
              <label className={labelClass}>Decode Note</label>
              <input
                type="text"
                value={decodeNote}
                onChange={e => setDecodeNote(e.target.value)}
                placeholder="Explanation of cryptic shorthand..."
                className={inputClass}
              />
            </div>
          )}

          {/* Proposed Thread */}
          <div>
            <label className={labelClass}>Proposed Thread</label>
            <input
              type="text"
              value={proposedThread}
              onChange={e => setProposedThread(e.target.value)}
              placeholder="Suggest a new thread name..."
              className={inputClass}
            />
          </div>

          {/* Entities */}
          <div>
            <h3 className="text-xs text-text-muted uppercase tracking-wider mb-3 font-medium">Entities</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>People (comma-separated)</label>
                <input type="text" value={people} onChange={e => setPeople(e.target.value)} placeholder="John Doe, Jane Smith" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Places (comma-separated)</label>
                <input type="text" value={places} onChange={e => setPlaces(e.target.value)} placeholder="Cleveland, Ohio" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Organizations (comma-separated)</label>
                <input type="text" value={organizations} onChange={e => setOrganizations(e.target.value)} placeholder="City Council, ACLU" className={inputClass} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-white/6">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit}>Save Changes</Button>
        </div>
      </div>
    </div>
  )
}
