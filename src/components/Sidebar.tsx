import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

type NavItem = { to: string; label: string; icon: string }
type NavGroup = { kind: 'group'; id: string; label: string; items: NavItem[] }
type NavLeaf = { kind: 'link'; id: string; label: string; to: string; icon: string }
type NavEntry = NavGroup | NavLeaf

const sections: NavEntry[] = [
  {
    kind: 'group',
    id: 'classifier',
    label: 'Catalog Classifier',
    items: [
      { to: '/run', label: 'Run Classification', icon: '▶' },
      { to: '/review', label: 'Review Table', icon: '☰' },
      { to: '/proposed-threads', label: 'Proposed Threads', icon: '◈' },
      { to: '/entities', label: 'Entity Browser', icon: '◉' },
      { to: '/clusters', label: 'Cluster Explorer', icon: '⬡' },
      { to: '/cryptic', label: 'Cryptic Queue', icon: '?' },
      { to: '/export', label: 'Export', icon: '↗' },
    ],
  },
  {
    kind: 'group',
    id: 'video',
    label: 'Video Pipeline',
    items: [
      { to: '/video/ingest', label: 'Ingest', icon: '▶' },
      { to: '/video/extract', label: 'Extract', icon: '◈' },
      { to: '/video/cluster', label: 'Cluster', icon: '⬡' },
      { to: '/video/synthesize', label: 'Synthesize', icon: '◉' },
      { to: '/video/review', label: 'Review', icon: '☰' },
    ],
  },
  {
    kind: 'group',
    id: 'utility',
    label: 'Utility',
    items: [
      { to: '/model-compare', label: 'Model Compare', icon: '⇄' },
    ],
  },
]

export function Sidebar() {
  const location = useLocation()
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      sections
        .filter((s): s is NavGroup => s.kind === 'group')
        .map((s) => [s.id, s.items.some((i) => location.pathname.startsWith(i.to))]),
    ),
  )

  const toggle = (id: string) =>
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }))

  return (
    <aside className="w-56 shrink-0 bg-bg2 border-r border-white/6 flex flex-col">
      <div className="p-5 border-b border-white/6">
        <h1 className="font-serif text-lg text-text-primary leading-tight">
          NEOBA Archive
        </h1>
      </div>

      <nav className="flex-1 py-3">
        {sections.map((section) => {
          if (section.kind === 'link') {
            return (
              <NavLink
                key={section.id}
                to={section.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                    isActive
                      ? 'text-maize bg-white/5 border-r-2 border-maize'
                      : 'text-text-muted hover:text-text-primary hover:bg-white/3'
                  }`
                }
              >
                <span className="text-[11px] leading-none w-5 text-center font-bold">
                  {section.icon}
                </span>
                <span className="font-mono uppercase tracking-wide text-xs">
                  {section.label}
                </span>
              </NavLink>
            )
          }

          const isOpen = openSections[section.id]
          const hasActive = section.items.some((i) =>
            location.pathname.startsWith(i.to),
          )
          return (
            <div key={section.id}>
              <button
                type="button"
                onClick={() => toggle(section.id)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  hasActive
                    ? 'text-maize'
                    : 'text-text-muted hover:text-text-primary hover:bg-white/3'
                }`}
              >
                <span className="text-[11px] leading-none w-5 text-center font-bold">
                  {isOpen ? '▼' : '▶'}
                </span>
                <span className="font-mono uppercase tracking-wide text-xs">
                  {section.label}
                </span>
              </button>
              {isOpen && (
                <div>
                  {section.items.map(({ to, label, icon }) => (
                    <NavLink
                      key={to}
                      to={to}
                      className={({ isActive }) =>
                        `flex items-center gap-3 pl-10 pr-5 py-2 text-sm transition-colors ${
                          isActive
                            ? 'text-maize bg-white/5 border-r-2 border-maize'
                            : 'text-text-muted hover:text-text-primary hover:bg-white/3'
                        }`
                      }
                    >
                      <span className="text-xs w-4 text-center opacity-70">
                        {icon}
                      </span>
                      {label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <div className="p-4 border-t border-white/6">
        <p className="text-xs text-text-dim font-mono">14,242 items</p>
      </div>
    </aside>
  )
}
