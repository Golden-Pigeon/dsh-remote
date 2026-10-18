/**
 * Live session follower: replay the missing suffix, then stream committed
 * events with gap/duplicate handling and heartbeats.
 *
 * A follower never executes anything. It is a read projection over
 * `session/event`, which keeps attach idempotent and safe across reconnects.
 *
 * @module dsh-remote-agent/stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  EventCursor,
  type SessionStreamFrame,
} from '@dsh-remote/protocol'
import { toWireEvent } from './projection.ts'
import { AsyncQueue } from './queue.ts'

/** Options for one live follower. */
export interface FollowOptions {
  readonly hostId: string
  readonly heartbeatMs: number
  readonly signal: AbortSignal
}

/**
 * Follow one live session from `startCursor`.
 *
 * The first frame is always `ready`; replayed and live events follow. The
 * generator ends on session disposal, client abort, or an event gap. It never
 * mutates the session.
 */
export async function* followLiveSession(
  ctx: Context,
  session: Session,
  startCursor: number,
  options: FollowOptions,
): AsyncGenerator<SessionStreamFrame> {
  const cursor = new EventCursor(startCursor)
  const queue = new AsyncQueue<SessionStreamFrame>(2_048)
  const sessionId = String(session.id)

  // Subscribe BEFORE reading the live length so nothing appended between the
  // snapshot and the subscription can be lost. A duplicate is filtered by the
  // cursor below.
  const onEvent = (owner: Session, event: SessionEvent): void => {
    if (owner.id !== session.id) return
    if (event.seq < cursor.next) return
    queue.push({
      type: 'event',
      cursor: cursor.next,
      event: toWireEvent(event),
    })
  }

  const onDisposed = (owner: Session): void => {
    if (owner.id !== session.id) return
    queue.push({ type: 'end', cursor: cursor.next, reason: 'session-closed' })
    queue.close()
  }

  const disposers = [
    ctx.on('session/event', onEvent),
    ctx.on('session/disposed', onDisposed),
  ]

  const heartbeat = setInterval(() => {
    queue.push({ type: 'heartbeat', cursor: cursor.next, time: Date.now() })
  }, options.heartbeatMs)
  heartbeat.unref?.()

  const onAbort = (): void => {
    queue.push({ type: 'end', cursor: cursor.next, reason: 'client-abort' })
    queue.close()
  }
  if (options.signal.aborted) onAbort()
  else options.signal.addEventListener('abort', onAbort, { once: true })

  const liveEnd = session.seq

  try {
    yield {
      type: 'ready',
      hostId: options.hostId,
      sessionId,
      cursor: cursor.next,
      live: true,
    }

    if (startCursor < liveEnd) {
      for (const event of session.snapshotEvents(startCursor as SessionLogOffset, liveEnd as SessionLogOffset)) {
        if (event.seq < cursor.next) continue
        if (event.seq > cursor.next) {
          yield { type: 'end', cursor: cursor.next, reason: 'error' }
          return
        }
        cursor.accept(event)
        yield {
          type: 'event',
          cursor: cursor.next,
          event: toWireEvent(event),
        }
      }
    }

    for await (const frame of queue) {
      if (frame.type === 'event') {
        const acceptance = cursor.inspect(frame.event)
        if (acceptance === 'duplicate') continue
        if (acceptance === 'gap') {
          yield { type: 'end', cursor: cursor.next, reason: 'error' }
          return
        }
        cursor.accept(frame.event)
      }
      yield frame
      if (frame.type === 'end') return
    }
  } finally {
    clearInterval(heartbeat)
    options.signal.removeEventListener('abort', onAbort)
    for (const dispose of disposers) dispose()
    queue.close()
  }
}
