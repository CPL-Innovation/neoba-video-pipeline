import type { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
  padding?: boolean
}

export function Card({ children, className = '', padding = true }: CardProps) {
  return (
    <div
      className={`bg-bg2 border border-white/6 rounded-xl ${
        padding ? 'p-5' : ''
      } ${className}`}
    >
      {children}
    </div>
  )
}
