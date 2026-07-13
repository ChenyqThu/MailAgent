import * as React from 'react'
import { motion, useReducedMotion } from 'motion/react'

import { cn } from '@shared/lib/cn'
import { EASE_OUT } from '@shared/lib/motion-tokens'

const DIGIT_HEIGHT_EM = 1.1
const DIGITS = Array.from({ length: 10 }, (_, digit) => digit)

export interface NumberTickerProps {
  value: number
  format?: (value: number) => string
  className?: string
  digitClassName?: string
}

export function NumberTicker({
  value,
  format = String,
  className,
  digitClassName
}: NumberTickerProps): React.ReactElement {
  const roundedValue = Math.round(value)
  const text = format(roundedValue)
  const glyphs = text.split('').map((char, index) => ({
    char,
    id: `g-${text.length - 1 - index}`
  }))

  return (
    <span className={cn('inline-flex items-center tabular-nums', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex items-center">
        {glyphs.map(({ char, id }) =>
          /\d/.test(char) ? (
            <TickerDigit key={id} digit={Number(char)} className={digitClassName} />
          ) : (
            <span key={id} className="inline-block">
              {char}
            </span>
          )
        )}
      </span>
    </span>
  )
}

function TickerDigit({
  digit,
  className
}: {
  digit: number
  className?: string
}): React.ReactElement {
  const reduceMotion = useReducedMotion()

  return (
    <span
      className={cn('relative inline-block overflow-hidden', className)}
      style={{ height: `${DIGIT_HEIGHT_EM}em`, width: '1ch' }}
    >
      <motion.span
        initial={false}
        animate={{ y: `-${digit * DIGIT_HEIGHT_EM}em` }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.9, ease: EASE_OUT }}
        className="absolute inset-x-0 top-0 flex flex-col items-center will-change-transform"
      >
        {DIGITS.map((candidate) => (
          <span key={candidate} className="flex h-[1.1em] items-center justify-center leading-none">
            {candidate}
          </span>
        ))}
      </motion.span>
    </span>
  )
}
