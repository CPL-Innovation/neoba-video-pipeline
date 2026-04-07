import { useState, useEffect, useMemo } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import type { EntityEntry, SourceItem, ClassifiedItem, EntityMergeSuggestion, SingleNameEntity } from '../../lib/types'

interface MergedItem extends SourceItem {
  item_id: string
  classification?: ClassifiedItem
}

const tabs = ['people', 'places', 'organizations'] as const

export function EntityBrowser() {
  const [entities, setEntities] = useState<EntityEntry[]>([])
  const [items, setItems] = useState<MergedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('people')
  const [search, setSearch] = useState('')
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null)

  // Merge mode state
  const [mergeMode, setMergeMode] = useState(false)
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set())
  const [canonicalName, setCanonicalName] = useState('')

  // Suggested merges
  const [suggestions, setSuggestions] = useState<EntityMergeSuggestion[]>([])
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set())

  // Single-name queue
  const [showSingleNameQueue, setShowSingleNameQueue] = useState(false)
  const [singleNameEntities, setSingleNameEntities] = useState<SingleNameEntity[]>([])
  const [resolveInputs, setResolveInputs] = useState<Record<string, string>>({})

  useEffect(() => {
    async function load() {
      try {
        const jsonArray = (r: Response) => r.ok ? r.json() : Promise.resolve([])
        const [entitiesData, sourceData, classData, suggestionsData, singleNameData] = await Promise.all([
          fetch('/api/run/latest/entities').then(jsonArray).catch(() => []),
          fetch('/api/source/items').then(jsonArray).catch(() => []),
          fetch('/api/run/latest/classifications').then(jsonArray).catch(() => []),
          fetch('/api/run/latest/entity-merge-suggestions').then(jsonArray).catch(() => []),
          fetch('/api/run/latest/entity-single-names').then(jsonArray).catch(() => []),
        ])
        setEntities(entitiesData)
        setSuggestions(suggestionsData)
        setSingleNameEntities(singleNameData)
        const classMap = new Map((classData as ClassifiedItem[]).map(c => [c.item_id, c]))
        setItems((sourceData as SourceItem[]).map(s => {
          const id = `${s.container}-${s.item}`
          return { ...s, item_id: id, classification: classMap.get(id) }
        }))
      } catch {
        setEntities([])
      }
      setLoading(false)
    }
    load()
  }, [])

  const filtered = useMemo(() =>
    entities
      .filter((e) => e.type === activeTab)
      .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.count - a.count),
    [entities, activeTab, search]
  )

  const tabSuggestions = useMemo(() =>
    suggestions
      .filter(s => s.entity_type === activeTab)
      .filter(s => !dismissedSuggestions.has(s.entities.join('|'))),
    [suggestions, activeTab, dismissedSuggestions]
  )

  const toggleSelection = (name: string) => {
    setSelectedForMerge((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const exitMergeMode = () => {
    setMergeMode(false)
    setSelectedForMerge(new Set())
    setCanonicalName('')
  }

  // Pre-fill canonical name with highest-count selected entity
  useEffect(() => {
    if (selectedForMerge.size > 0) {
      const selected = [...selectedForMerge]
      const best = selected.reduce((a, b) => {
        const aEntry = entities.find(e => e.name === a)
        const bEntry = entities.find(e => e.name === b)
        const aCount = aEntry?.count ?? 0
        const bCount = bEntry?.count ?? 0
        if (aCount !== bCount) return aCount > bCount ? a : b
        return a.length > b.length ? a : b
      })
      setCanonicalName(best)
    }
  }, [selectedForMerge, entities])

  const handleMergeConfirm = async () => {
    const target = canonicalName.trim()
    if (!target || selectedForMerge.size < 2) return

    const sources = [...selectedForMerge].filter(n => n !== target)

    // Post to backend
    await fetch('/api/run/latest/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'entity_merge',
        source_entities: sources,
        target_entity: target,
        entity_type: activeTab,
      }),
    })

    // Optimistic update: combine entities locally
    setEntities(prev => {
      const sourceSet = new Set(sources.map(s => s.toLowerCase()))
      const sourceEntries = prev.filter(e => sourceSet.has(e.name.toLowerCase()))
      const remaining = prev.filter(e => !sourceSet.has(e.name.toLowerCase()))

      const targetEntry = remaining.find(e => e.name.toLowerCase() === target.toLowerCase())
      const combinedItemIds = [
        ...(targetEntry?.item_ids ?? []),
        ...sourceEntries.flatMap(e => e.item_ids),
      ]
      const dedupedIds = [...new Set(combinedItemIds)]

      if (targetEntry) {
        return remaining.map(e =>
          e.name.toLowerCase() === target.toLowerCase()
            ? { ...e, name: target, count: dedupedIds.length, item_ids: dedupedIds }
            : e
        )
      } else {
        // Target is a new name
        return [
          ...remaining,
          {
            name: target,
            type: activeTab,
            count: dedupedIds.length,
            item_ids: dedupedIds,
          },
        ]
      }
    })

    // Remove merged suggestions that included any of these entities
    setSuggestions(prev => prev.filter(s =>
      !sources.some(src => s.entities.includes(src)) &&
      !s.entities.includes(target)
    ))

    exitMergeMode()
    setSelectedEntity(null)
  }

  const handleAcceptSuggestion = async (suggestion: EntityMergeSuggestion) => {
    const target = suggestion.suggested_canonical
    const sources = suggestion.entities.filter(n => n !== target)

    await fetch('/api/run/latest/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'entity_merge',
        source_entities: sources,
        target_entity: target,
        entity_type: suggestion.entity_type,
      }),
    })

    // Optimistic update
    setEntities(prev => {
      const sourceSet = new Set(sources.map(s => s.toLowerCase()))
      const sourceEntries = prev.filter(e => sourceSet.has(e.name.toLowerCase()))
      const remaining = prev.filter(e => !sourceSet.has(e.name.toLowerCase()))

      const targetEntry = remaining.find(e => e.name.toLowerCase() === target.toLowerCase())
      const combinedItemIds = [
        ...(targetEntry?.item_ids ?? []),
        ...sourceEntries.flatMap(e => e.item_ids),
      ]
      const dedupedIds = [...new Set(combinedItemIds)]

      if (targetEntry) {
        return remaining.map(e =>
          e.name.toLowerCase() === target.toLowerCase()
            ? { ...e, name: target, count: dedupedIds.length, item_ids: dedupedIds }
            : e
        )
      }
      return [
        ...remaining,
        { name: target, type: suggestion.entity_type, count: dedupedIds.length, item_ids: dedupedIds },
      ]
    })

    // Remove this suggestion
    setSuggestions(prev => prev.filter(s => s !== suggestion))
  }

  const handleDismissSuggestion = (suggestion: EntityMergeSuggestion) => {
    setDismissedSuggestions(prev => new Set([...prev, suggestion.entities.join('|')]))
  }

  const handleResolveSingleName = async (name: string, fullName: string) => {
    if (!fullName.trim()) return

    await fetch('/api/run/latest/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'entity_merge',
        source_entities: [name],
        target_entity: fullName.trim(),
        entity_type: 'people',
      }),
    })

    // Optimistic update: merge into target or create new
    setEntities(prev => {
      const sourceEntry = prev.find(e => e.name === name)
      if (!sourceEntry) return prev
      const remaining = prev.filter(e => e.name !== name)
      const targetEntry = remaining.find(e => e.name.toLowerCase() === fullName.trim().toLowerCase())
      const combinedIds = [...new Set([
        ...(targetEntry?.item_ids ?? []),
        ...sourceEntry.item_ids,
      ])]

      if (targetEntry) {
        return remaining.map(e =>
          e.name.toLowerCase() === fullName.trim().toLowerCase()
            ? { ...e, count: combinedIds.length, item_ids: combinedIds }
            : e
        )
      }
      return [
        ...remaining,
        { name: fullName.trim(), type: 'people' as const, count: combinedIds.length, item_ids: combinedIds },
      ]
    })

    setSingleNameEntities(prev => prev.filter(e => e.name !== name))
    setResolveInputs(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  const matchTypeLabel: Record<string, string> = {
    substring: 'Substring',
    abbreviation: 'Abbreviation',
    prefix: 'Prefix',
    normalized: 'Normalized',
    mixed: 'Mixed',
  }

  return (
    <div className="relative pb-20">
      <div className="flex items-center justify-between mb-1">
        <PageHeader
          title="Entity Browser"
          description="Browse deduplicated entities extracted across the archive — people, places, and organizations."
        />
        <div className="flex gap-2 shrink-0">
          {activeTab === 'people' && !mergeMode && singleNameEntities.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowSingleNameQueue(!showSingleNameQueue)}
            >
              {showSingleNameQueue ? 'Close Queue' : `Single-Name Queue (${singleNameEntities.length})`}
            </Button>
          )}
          {!mergeMode && filtered.length >= 2 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setMergeMode(true); setShowSingleNameQueue(false) }}
            >
              Merge Entities
            </Button>
          )}
          {mergeMode && (
            <Button size="sm" variant="ghost" onClick={exitMergeMode}>
              Cancel Merge
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-white/6 pb-px">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => {
              setActiveTab(tab)
              setSelectedEntity(null)
              exitMergeMode()
              setShowSingleNameQueue(false)
            }}
            className={`px-4 py-2 text-sm capitalize transition-colors cursor-pointer ${
              activeTab === tab
                ? 'text-maize border-b-2 border-maize -mb-px'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {tab}
            <span className="ml-1.5 text-xs text-text-dim font-mono">
              {entities.filter(e => e.type === tab).length}
            </span>
          </button>
        ))}
      </div>

      {/* Single-Name Resolution Queue */}
      {showSingleNameQueue && (
        <Card className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-primary">
              Single-Name Resolution Queue
            </h3>
            <span className="text-xs text-text-dim">
              People with single names (count &ge; 3) — resolve to full names for better matching
            </span>
          </div>
          <div className="space-y-2 max-h-[50vh] overflow-y-auto">
            {singleNameEntities.map(entity => (
              <div
                key={entity.name}
                className="px-4 py-3 rounded-lg bg-bg3/50 border border-white/4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <span className="text-sm font-medium text-text-primary">{entity.name}</span>
                      <span className="text-xs font-mono text-text-dim">{entity.count} items</span>
                    </div>
                    <div className="space-y-0.5">
                      {entity.sample_descriptions.map((d, i) => (
                        <p key={i} className="text-xs text-text-muted font-mono truncate">{d}</p>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="text"
                      placeholder="Full name..."
                      value={resolveInputs[entity.name] ?? ''}
                      onChange={e => setResolveInputs(prev => ({ ...prev, [entity.name]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleResolveSingleName(entity.name, resolveInputs[entity.name] ?? '')
                      }}
                      className="w-48 bg-bg3 border border-white/10 rounded-md px-3 py-1.5 text-sm text-text-primary"
                    />
                    <Button
                      size="sm"
                      disabled={!resolveInputs[entity.name]?.trim()}
                      onClick={() => handleResolveSingleName(entity.name, resolveInputs[entity.name] ?? '')}
                    >
                      Resolve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSingleNameEntities(prev => prev.filter(e => e.name !== entity.name))}
                    >
                      Skip
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {singleNameEntities.length === 0 && (
              <p className="text-xs text-text-dim py-2">All single-name entities have been resolved.</p>
            )}
          </div>
        </Card>
      )}

      {/* Suggested Merges */}
      {tabSuggestions.length > 0 && !mergeMode && (
        <Card className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-primary">
              Suggested Merges
            </h3>
            <span className="text-xs text-text-dim">
              {tabSuggestions.length} group{tabSuggestions.length !== 1 ? 's' : ''} detected
            </span>
          </div>
          <div className="space-y-2 max-h-[40vh] overflow-y-auto">
            {tabSuggestions.map((suggestion, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-bg3/50 border border-white/4"
              >
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  {suggestion.entities.map(name => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-purple/15 text-purple"
                    >
                      {name}
                      <span className="text-purple/60 font-mono">{suggestion.counts[name]}</span>
                    </span>
                  ))}
                  <span className="text-xs text-text-dim">
                    &rarr; <span className="text-text-muted">{suggestion.suggested_canonical}</span>
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-text-dim">
                    {matchTypeLabel[suggestion.match_type]}
                  </span>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" onClick={() => handleAcceptSuggestion(suggestion)}>
                    Accept
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleDismissSuggestion(suggestion)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex gap-5">
        {/* Entity list */}
        <Card className="w-80 shrink-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search entities..."
            className="w-full bg-bg3 border border-white/10 rounded-md px-3 py-2 text-sm text-text-primary mb-3"
          />

          {loading ? (
            <p className="text-xs text-text-dim">Loading...</p>
          ) : (
            <div className="space-y-1 max-h-[60vh] overflow-y-auto">
              {filtered.map((e) => (
                <button
                  key={e.name}
                  onClick={() => {
                    if (mergeMode) {
                      toggleSelection(e.name)
                    } else {
                      setSelectedEntity(e.name)
                    }
                  }}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors cursor-pointer flex items-center gap-2 ${
                    mergeMode && selectedForMerge.has(e.name)
                      ? 'bg-purple/10 ring-1 ring-purple text-text-primary'
                      : selectedEntity === e.name
                        ? 'bg-white/8 text-text-primary'
                        : 'text-text-muted hover:bg-white/4'
                  }`}
                >
                  {mergeMode && (
                    <input
                      type="checkbox"
                      checked={selectedForMerge.has(e.name)}
                      onChange={() => toggleSelection(e.name)}
                      onClick={(ev) => ev.stopPropagation()}
                      className="rounded shrink-0"
                    />
                  )}
                  <span className="truncate flex-1">{e.name}</span>
                  <span className="font-mono text-xs text-text-dim shrink-0">
                    {e.count}
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-xs text-text-dim py-2">
                  {entities.length === 0
                    ? 'No entities yet. Run classification first.'
                    : 'No matches found.'}
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Entity detail */}
        <div className="flex-1 min-w-0">
          {selectedEntity && !mergeMode ? (
            <EntityDetail
              entityName={selectedEntity}
              entity={filtered.find(e => e.name === selectedEntity)}
              items={items}
            />
          ) : mergeMode ? (
            <Card>
              <p className="text-sm text-text-muted">
                Select entities from the list to merge them. {selectedForMerge.size > 0
                  ? `${selectedForMerge.size} selected.`
                  : 'Click entities or use checkboxes to select.'}
              </p>
              {selectedForMerge.size > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {[...selectedForMerge].map(name => (
                    <Badge
                      key={name}
                      label={`${name} (${entities.find(e => e.name === name)?.count ?? 0})`}
                      color="#a78bfa"
                      onRemove={() => toggleSelection(name)}
                    />
                  ))}
                </div>
              )}
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-text-dim">Select an entity to see referencing items.</p>
            </Card>
          )}
        </div>
      </div>

      {/* Merge bar */}
      {mergeMode && selectedForMerge.size >= 2 && (
        <div className="fixed bottom-0 left-0 right-0 bg-bg2 border-t border-white/10 px-6 py-4 z-50">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-text-dim mb-2">
                Merging {selectedForMerge.size} entities: {[...selectedForMerge].join(', ')}
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

function EntityDetail({
  entityName,
  entity,
  items,
}: {
  entityName: string
  entity?: EntityEntry
  items: MergedItem[]
}) {
  const referencedItems = useMemo(() => {
    if (!entity) return []
    const idSet = new Set(entity.item_ids)
    return items.filter(i => idSet.has(i.item_id))
  }, [entity, items])

  return (
    <Card>
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="font-serif text-lg text-text-primary">{entityName}</h3>
        <span className="text-xs text-text-dim font-mono">
          {referencedItems.length} item{referencedItems.length !== 1 ? 's' : ''}
        </span>
      </div>

      {referencedItems.length === 0 ? (
        <p className="text-xs text-text-dim">No matching items found.</p>
      ) : (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {referencedItems.map((item) => (
            <div
              key={item.item_id}
              className="px-3 py-2.5 rounded-lg bg-bg3/50 border border-white/4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-text-dim">{item.item_id}</span>
                    {item.date && (
                      <span className="text-xs text-text-dim">{item.date}</span>
                    )}
                  </div>
                  <p className="text-sm text-text-primary">{item.description}</p>
                </div>
                <div className="flex flex-wrap gap-1 shrink-0">
                  {item.classification?.threads.map((t) => (
                    <Badge key={t.name} label={t.name} />
                  ))}
                </div>
              </div>
              {item.classification && (
                <div className="flex gap-3 mt-2 text-xs text-text-dim">
                  <span>Genre: {item.classification.genre}</span>
                  {item.classification.is_cryptic && (
                    <span className="text-coral">Cryptic</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
