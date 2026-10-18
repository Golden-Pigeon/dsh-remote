/**
 * Event cursor rules.
 *
 * A cursor is the next sequence number a consumer expects. Session events
 * carry a gap-free, monotonically increasing `seq`; a duplicated event is a
 * no-op and a forward jump is a gap that must be repaired with a fresh
 * snapshot rather than silently ignored.
 *
 * @module @dsh-remote/protocol/cursor
 */

import type { RemoteSessionEvent } from './types.ts'

/** Outcome of feeding one event into a cursor. */
export type CursorAcceptance = 'applied' | 'duplicate' | 'gap'

/** Mutable cursor over a session event stream. */
export class EventCursor {
  #next: number

  constructor(start = 0) {
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new RangeError(`invalid cursor start: ${String(start)}`)
    }
    this.#next = start
  }

  /** Next expected sequence number. */
  get next(): number {
    return this.#next
  }

  /** Replace the cursor after a snapshot or repair. */
  reset(next: number): void {
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new RangeError(`invalid cursor reset: ${String(next)}`)
    }
    this.#next = next
  }

  /** Check an event against the cursor without mutating it. */
  inspect(event: Pick<RemoteSessionEvent, 'seq'>): CursorAcceptance {
    if (event.seq < this.#next) return 'duplicate'
    if (event.seq > this.#next) return 'gap'
    return 'applied'
  }

  /** Advance on an applied event; duplicate and gap events leave it untouched. */
  accept(event: Pick<RemoteSessionEvent, 'seq'>): CursorAcceptance {
    const result = this.inspect(event)
    if (result === 'applied') this.#next += 1
    return result
  }
}

/** True when a cursor value is a non-negative safe integer. */
export function isCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Parse a cursor from a query string, rejecting malformed values. */
export function parseCursorQuery(value: string | null | undefined, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new RangeError(`invalid cursor: ${JSON.stringify(value)}`)
  const parsed = Number(value)
  if (!isCursor(parsed)) throw new RangeError(`invalid cursor: ${JSON.stringify(value)}`)
  return parsed
}

/** Compute the cursor that follows one event. */
export function cursorAfter(event: Pick<RemoteSessionEvent, 'seq'>): number {
  return event.seq + 1
}
