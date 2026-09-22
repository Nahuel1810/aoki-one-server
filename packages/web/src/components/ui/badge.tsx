import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'
import { badgeVariants } from './badge-variants'

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
