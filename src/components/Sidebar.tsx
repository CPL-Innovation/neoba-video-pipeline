import { useState, type ComponentType } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Zap,
  Table2,
  GitBranch,
  Users,
  Hexagon,
  HelpCircle,
  Upload,
  Download,
  Scissors,
  FlaskConical,
  BarChart3,
  ArrowLeftRight,
  BookOpen,
  Film,
  Wrench,
  type LucideProps,
} from 'lucide-react'

type NavItem = { to: string; label: string; icon: ComponentType<LucideProps> }
type NavGroup = { kind: 'group'; id: string; label: string; icon: ComponentType<LucideProps>; items: NavItem[] }
type NavLeaf = { kind: 'link'; id: string; label: string; to: string; icon: ComponentType<LucideProps> }
type NavEntry = NavGroup | NavLeaf

const sections: NavEntry[] = [
  {
    kind: 'group',
    id: 'classifier',
    label: 'Catalog Classifier',
    icon: BookOpen,
    items: [
      { to: '/run', label: 'Run Classification', icon: Zap },
      { to: '/review', label: 'Review Table', icon: Table2 },
      { to: '/proposed-threads', label: 'Proposed Threads', icon: GitBranch },
      { to: '/entities', label: 'Entity Browser', icon: Users },
      { to: '/clusters', label: 'Cluster Explorer', icon: Hexagon },
      { to: '/cryptic', label: 'Cryptic Queue', icon: HelpCircle },
      { to: '/export', label: 'Export', icon: Upload },
    ],
  },
  {
    kind: 'group',
    id: 'video',
    label: 'Video Pipeline',
    icon: Film,
    items: [
      { to: '/video/ingest', label: 'Ingest', icon: Download },
      { to: '/video/extract', label: 'Extract', icon: Scissors },
      { to: '/video/cluster', label: 'Cluster', icon: Hexagon },
      { to: '/video/synthesize', label: 'Synthesize', icon: FlaskConical },
      { to: '/video/review', label: 'Review', icon: BarChart3 },
    ],
  },
  {
    kind: 'group',
    id: 'utility',
    label: 'Utility',
    icon: Wrench,
    items: [
      { to: '/model-compare', label: 'Model Compare', icon: ArrowLeftRight },
    ],
  },
]

export function Sidebar({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
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

  const iconSize = 15

  return (
    <aside className={`${collapsed ? 'w-12' : 'w-56'} shrink-0 bg-bg2 border-r border-white/6 flex flex-col transition-all duration-200`}>
      <div className={`flex items-center border-b border-white/6 ${collapsed ? 'p-2 justify-center' : 'p-5 justify-between'}`}>
        {!collapsed && (
          <div className="flex flex-col leading-tight">
            <h1 className="font-serif text-lg text-text-primary">
              NEOBA Archive
            </h1>
            <span className="text-xs text-text-dim tracking-wide mt-0.5">
              Cleveland Public Library
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="text-text-dim hover:text-text-primary text-xs p-1 rounded hover:bg-white/5 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '▶' : '◀'}
        </button>
      </div>

      <nav className="flex-1 py-3 overflow-hidden">
        {sections.map((section) => {
          if (section.kind === 'link') {
            const Icon = section.icon
            return (
              <NavLink
                key={section.id}
                to={section.to}
                title={collapsed ? section.label : undefined}
                className={({ isActive }) =>
                  `flex items-center gap-3 ${collapsed ? 'justify-center px-2' : 'px-5'} py-2.5 text-sm transition-colors ${
                    isActive
                      ? 'text-maize bg-white/5 border-r-2 border-maize'
                      : 'text-text-muted hover:text-text-primary hover:bg-white/3'
                  }`
                }
              >
                <Icon size={iconSize} className="shrink-0" />
                {!collapsed && (
                  <span className="font-mono uppercase tracking-wide text-xs">
                    {section.label}
                  </span>
                )}
              </NavLink>
            )
          }

          const isOpen = openSections[section.id]
          const hasActive = section.items.some((i) =>
            location.pathname.startsWith(i.to),
          )
          const SectionIcon = section.icon

          // Collapsed: show section icon + item icons vertically
          if (collapsed) {
            return (
              <div key={section.id} className="border-b border-white/4 pb-1 mb-1">
                <button
                  type="button"
                  onClick={() => toggle(section.id)}
                  title={section.label}
                  className={`w-full flex justify-center px-2 py-2 transition-colors ${
                    hasActive
                      ? 'text-maize'
                      : 'text-text-muted hover:text-text-primary hover:bg-white/3'
                  }`}
                >
                  <SectionIcon size={iconSize} />
                </button>
                {isOpen && (
                  <div className="space-y-0.5">
                    {section.items.map(({ to, label, icon: ItemIcon }) => (
                      <NavLink
                        key={to}
                        to={to}
                        title={label}
                        className={({ isActive }) =>
                          `flex justify-center px-2 py-1.5 transition-colors ${
                            isActive
                              ? 'text-maize bg-white/5 border-r-2 border-maize'
                              : 'text-text-muted hover:text-text-primary hover:bg-white/3'
                          }`
                        }
                      >
                        <ItemIcon size={13} />
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          }

          // Expanded: normal layout
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
                <SectionIcon size={iconSize} className="shrink-0" />
                <span className="font-mono uppercase tracking-wide text-xs">
                  {section.label}
                </span>
                <span className="text-[10px] leading-none ml-auto opacity-50">
                  {isOpen ? '▼' : '▶'}
                </span>
              </button>
              {isOpen && (
                <div>
                  {section.items.map(({ to, label, icon: ItemIcon }) => (
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
                      <ItemIcon size={13} className="shrink-0 opacity-70" />
                      {label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {!collapsed && (
        <div className="p-4 border-t border-white/6">
          <p className="text-xs text-text-dim font-mono">14,242 items</p>
        </div>
      )}
    </aside>
  )
}
