import { THREAD_COLORS } from '../lib/constants'

interface BadgeProps {
  label: string
  color?: string
  onRemove?: () => void
  size?: 'sm' | 'md'
}

export function Badge({ label, color, onRemove, size = 'sm' }: BadgeProps) {
  const bgColor = color || THREAD_COLORS[label] || 'var(--color-text-dim)'
  const sizeClasses = size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-3 py-1'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${sizeClasses}`}
      style={{ backgroundColor: `color-mix(in srgb, ${bgColor} 20%, transparent)`, color: bgColor }}
    >
      {label}
      {onRemove && (
        <button
          onClick={onRemove}
          className="ml-0.5 hover:opacity-70 transition-opacity"
          aria-label={`Remove ${label}`}
        >
          ×
        </button>
      )}
    </span>
  )
}
