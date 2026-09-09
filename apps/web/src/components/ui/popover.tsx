import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Modal by default so page scroll stays locked and outside interactions are
 * blocked while a popover (e.g. a combobox inside a Dialog) is open.
 */
function Popover({
  modal = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root modal={modal} {...props} />
}

const PopoverTrigger = PopoverPrimitive.Trigger

type PopoverContentProps = React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Popup
> &
  Pick<
    React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Positioner>,
    | 'align'
    | 'alignOffset'
    | 'side'
    | 'sideOffset'
    | 'collisionPadding'
    | 'collisionAvoidance'
    | 'positionMethod'
  >

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Popup>,
  PopoverContentProps
>(
  (
    {
      className,
      align = 'center',
      alignOffset,
      side,
      sideOffset = 4,
      collisionPadding = 8,
      collisionAvoidance = { side: 'flip', align: 'shift' },
      positionMethod,
      ...props
    },
    ref,
  ) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
        positionMethod={positionMethod}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          ref={ref}
          className={cn(
            'motion-popover z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden transition-[opacity,scale] duration-[var(--motion-duration-slow)] ease-[var(--motion-ease-out)] data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  ),
)
PopoverContent.displayName = 'PopoverContent'

export { Popover, PopoverContent, PopoverTrigger }
