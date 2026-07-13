import { motion, useReducedMotion } from 'motion/react'

import { cn } from '@shared/lib/cn'
import { EASE_IN_OUT } from '@shared/lib/motion-tokens'

export type LoaderVariant = 'spinner' | 'dots' | 'bars' | 'dot-matrix'

export interface LoaderProps {
  variant?: LoaderVariant
  size?: number
  speed?: number
  label?: string
  className?: string
}

interface LoaderPartProps {
  size: number
  speed: number
  reduceMotion: boolean
}

const REDUCED_TRANSITION = {
  duration: 1.4,
  ease: EASE_IN_OUT,
  repeat: Infinity
} as const

export function Loader({
  variant = 'spinner',
  size = 32,
  speed = 1,
  label = 'Loading',
  className
}: LoaderProps): React.ReactElement {
  const reduceMotion = useReducedMotion() ?? false

  return (
    <span
      role="status"
      aria-label={label}
      className={cn('inline-flex items-center justify-center', className)}
    >
      {variant === 'spinner' && <Spinner size={size} speed={speed} reduceMotion={reduceMotion} />}
      {variant === 'dots' && <Dots size={size} speed={speed} reduceMotion={reduceMotion} />}
      {variant === 'bars' && <Bars size={size} speed={speed} reduceMotion={reduceMotion} />}
      {variant === 'dot-matrix' && (
        <DotMatrix size={size} speed={speed} reduceMotion={reduceMotion} />
      )}
    </span>
  )
}

function Spinner({ size, speed, reduceMotion }: LoaderPartProps): React.ReactElement {
  const stroke = Math.max(2, size * 0.09)
  const radius = (size - stroke) / 2

  return (
    <motion.svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      animate={reduceMotion ? { opacity: [1, 0.4, 1] } : { rotate: 360 }}
      transition={
        reduceMotion ? REDUCED_TRANSITION : { duration: speed, ease: 'linear', repeat: Infinity }
      }
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={stroke}
      />
      <path
        d={`M ${size / 2} ${size / 2 - radius} A ${radius} ${radius} 0 0 1 ${size / 2 + radius} ${size / 2}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
      />
    </motion.svg>
  )
}

function Dots({ size, speed, reduceMotion }: LoaderPartProps): React.ReactElement {
  const dotSize = size * 0.24

  return (
    <span className="flex items-center" style={{ gap: size * 0.14 }}>
      {[0, 1, 2].map((index) => (
        <motion.span
          key={index}
          className="rounded-full bg-current"
          style={{ width: dotSize, height: dotSize }}
          animate={
            reduceMotion
              ? { opacity: [0.4, 1, 0.4] }
              : { y: [0, -size * 0.3, 0], opacity: [0.5, 1, 0.5] }
          }
          transition={{
            duration: speed,
            ease: EASE_IN_OUT,
            repeat: Infinity,
            delay: index * speed * 0.16
          }}
        />
      ))}
    </span>
  )
}

function Bars({ size, speed, reduceMotion }: LoaderPartProps): React.ReactElement {
  const barWidth = size * 0.16

  return (
    <span className="flex items-center" style={{ gap: size * 0.1, height: size }}>
      {[0, 1, 2, 3].map((index) => (
        <motion.span
          key={index}
          className="rounded-full bg-current"
          style={{ width: barWidth, height: size, originY: 1 }}
          animate={reduceMotion ? { opacity: [0.4, 1, 0.4] } : { scaleY: [0.3, 1, 0.3] }}
          transition={{
            duration: speed,
            ease: EASE_IN_OUT,
            repeat: Infinity,
            delay: index * speed * 0.12
          }}
        />
      ))}
    </span>
  )
}

function DotMatrix({ size, speed, reduceMotion }: LoaderPartProps): React.ReactElement {
  const dimension = 3
  const gap = size * 0.14
  const dotSize = (size - gap * (dimension - 1)) / dimension
  const cells = Array.from({ length: dimension * dimension }, (_, index) => index)

  return (
    <span
      className="grid"
      style={{ gap, gridTemplateColumns: `repeat(${dimension}, ${dotSize}px)` }}
    >
      {cells.map((index) => {
        const x = index % dimension
        const y = Math.floor(index / dimension)
        const delay = ((x + y) / (2 * (dimension - 1))) * speed

        return (
          <motion.span
            key={index}
            className="rounded-full bg-current"
            style={{ width: dotSize, height: dotSize }}
            animate={
              reduceMotion
                ? { opacity: [0.3, 1, 0.3] }
                : { opacity: [0.2, 1, 0.2], scale: [0.7, 1, 0.7] }
            }
            transition={{ duration: speed, ease: EASE_IN_OUT, repeat: Infinity, delay }}
          />
        )
      })}
    </span>
  )
}
