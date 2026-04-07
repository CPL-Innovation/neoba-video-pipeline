import { useState, useEffect } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { Card } from '../../components/Card'
import type { EntityEntry } from '../../lib/types'

const tabs = ['people', 'places', 'organizations'] as const

export function EntityBrowser() {
  const [entities, setEntities] = useState<EntityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>('people')
  const [search, setSearch] = useState('')
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/run/latest/entities')
      .then((r) => r.json())
      .then(setEntities)
      .catch(() => setEntities([]))
      .finally(() => setLoading(false))
  }, [])

  const filtered = entities
    .filter((e) => e.type === activeTab)
    .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.count - a.count)

  return (
    <div>
      <PageHeader
        title="Entity Browser"
        description="Browse deduplicated entities extracted across the archive — people, places, and organizations."
      />

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-white/6 pb-px">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setSelectedEntity(null) }}
            className={`px-4 py-2 text-sm capitalize transition-colors cursor-pointer ${
              activeTab === tab
                ? 'text-maize border-b-2 border-maize -mb-px'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

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
                  onClick={() => setSelectedEntity(e.name)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${
                    selectedEntity === e.name
                      ? 'bg-white/8 text-text-primary'
                      : 'text-text-muted hover:bg-white/4'
                  }`}
                >
                  <span>{e.name}</span>
                  <span className="float-right font-mono text-xs text-text-dim">
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
        <div className="flex-1">
          {selectedEntity ? (
            <Card>
              <h3 className="font-serif text-lg text-text-primary mb-3">{selectedEntity}</h3>
              <p className="text-xs text-text-dim">
                Items referencing this entity will appear here after classification.
              </p>
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-text-dim">Select an entity to see referencing items.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
