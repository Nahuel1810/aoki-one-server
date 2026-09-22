import { Slot } from '@radix-ui/react-slot'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/cn'
import { buttonVariants } from './button-variants'

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

export function Button({
  className,
  variant,
  size,
  block,
  asChild = false,
  type = 'button',
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...(asChild ? {} : { type })}
      {...props}
    />
  )
}
