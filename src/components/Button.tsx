import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
}

const variantClasses = {
  primary: 'bg-maize text-bg font-medium hover:brightness-110',
  secondary: 'bg-surface text-text-primary border border-white/10 hover:bg-white/10',
  ghost: 'text-text-muted hover:text-text-primary hover:bg-white/5',
}

const sizeClasses = {
  sm: 'text-xs px-3 py-1.5 rounded-md',
  md: 'text-sm px-4 py-2 rounded-lg',
  lg: 'text-sm px-5 py-2.5 rounded-lg',
}

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 transition-all cursor-pointer
        ${variantClasses[variant]} ${sizeClasses[size]}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}
