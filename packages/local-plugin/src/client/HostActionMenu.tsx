/**
 * A small action menu anchored to a trigger button.
 *
 * Rendered into a fixed layer rather than as a positioned child: the Settings
 * slot can clip overflow, and a menu inside it would be cut off near the last
 * host card. Fixed placement costs a reposition on scroll and resize, which is
 * cheaper than depending on the host container's overflow.
 *
 * @module dsh-remote-local/client/HostActionMenu
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** One entry in the menu. */
export interface MenuAction {
  readonly id: string
  readonly label: string
  readonly danger?: boolean
  /** Draw a divider above this entry. */
  readonly separated?: boolean
  readonly disabled?: boolean
  readonly run: () => void
}

/** Props for {@link HostActionMenu}. */
export interface HostActionMenuProps {
  /** Accessible name for the trigger and the popup. */
  readonly label: string
  readonly actions: readonly MenuAction[]
}

/** Gap between the trigger and the popup. */
const OFFSET = 4
/** Minimum distance kept from the viewport edge. */
const MARGIN = 8

/**
 * Trigger button plus its popup.
 *
 * @param props - the menu label and its entries.
 * @returns the trigger and, while open, the popup layer.
 */
export function HostActionMenu({ label, actions }: HostActionMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  /**
   * Place the popup under the trigger, right-aligned, kept inside the viewport.
   *
   * Runs before paint so the popup never flashes at the wrong spot.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current
    const popup = popupRef.current
    if (trigger === null || popup === null) return
    const anchor = trigger.getBoundingClientRect()
    const width = popup.offsetWidth
    const height = popup.offsetHeight
    const maxLeft = window.innerWidth - width - MARGIN
    const left = Math.max(MARGIN, Math.min(anchor.right - width, maxLeft))
    // Flip above the trigger when there is no room below it.
    const below = anchor.bottom + OFFSET
    const top = below + height > window.innerHeight - MARGIN && anchor.top - height - OFFSET > MARGIN
      ? anchor.top - height - OFFSET
      : below
    setPosition({ top, left })
  }, [])

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (popupRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    // Reposition rather than close: the anchor moves with the list.
    const onScroll = (): void => { place() }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    // Focus the first entry so the menu is usable from the keyboard.
    popupRef.current?.querySelector('button')?.focus()
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, place])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="dshr-button dshr-button-small dshr-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={event => {
          // The trigger sits inside a row whose click expands the host; without
          // this the menu would open and the row would toggle at once.
          event.stopPropagation()
          setOpen(current => !current)
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={popupRef}
          className="dshr-menu"
          role="menu"
          aria-label={label}
          style={position === null
            ? { visibility: 'hidden' }
            : { top: `${position.top}px`, left: `${position.left}px` }}
        >
          {actions.map(action => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={[
                'dshr-menu-item',
                action.danger === true ? 'dshr-menu-item-danger' : '',
                action.separated === true ? 'dshr-menu-item-separated' : '',
              ].filter(Boolean).join(' ')}
              disabled={action.disabled === true}
              onClick={() => {
                setOpen(false)
                action.run()
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
