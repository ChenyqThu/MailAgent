// Sprint 18 — shadcn Label primitive (Radix Label).
//
// Wraps `LabelPrimitive.Root` so we can co-locate the typography token
// (text-aux / font-medium) once and stop sprinkling those classes on every
// form row.

import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'

import { cn } from '@shared/lib/cn'

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-aux font-medium text-ink-fg',
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
      className
    )}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName
