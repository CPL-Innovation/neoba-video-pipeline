import { NavLink } from 'react-router-dom'

const navItems = [
  { to: '/run', label: 'Run Classification', icon: '▶' },
  { to: '/review', label: 'Review Table', icon: '☰' },
  { to: '/proposed-threads', label: 'Proposed Threads', icon: '◈' },
  { to: '/entities', label: 'Entity Browser', icon: '◉' },
  { to: '/clusters', label: 'Cluster Explorer', icon: '⬡' },
  { to: '/cryptic', label: 'Cryptic Queue', icon: '?' },
  { to: '/export', label: 'Export', icon: '↗' },
]

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 bg-bg2 border-r border-white/6 flex flex-col">
      <div className="p-5 border-b border-white/6">
        <h1 className="font-serif text-lg text-text-primary leading-tight">
          NEOBA Archive
        </h1>
        <p className="text-xs text-text-dim mt-1 font-mono">Classifier</p>
      </div>

      <nav className="flex-1 py-3">
        {navItems.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                isActive
                  ? 'text-maize bg-white/5 border-r-2 border-maize'
                  : 'text-text-muted hover:text-text-primary hover:bg-white/3'
              }`
            }
          >
            <span className="text-xs w-4 text-center opacity-70">{icon}</span>
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="p-4 border-t border-white/6">
        <p className="text-xs text-text-dim font-mono">14,242 items</p>
      </div>
    </aside>
  )
}
