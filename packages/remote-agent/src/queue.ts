/**
 * Async delivery queue used by the session follower.
 *
 * It is a bounded push queue with iterator semantics: producers push frames,
 * the SSE route drains them with `for await`. Overflow fails the stream
 * instead of growing without bound behind a slow client.
 *
 * @module dsh-remote-agent/queue
 */

interface Waiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void
  readonly reject: (error: unknown) => void
}

/** Bounded async queue. */
export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #capacity: number
  readonly #values: T[] = []
  readonly #waiters: Waiter<T>[] = []
  #closed = false
  #failure: unknown

  constructor(capacity = 2_048) {
    this.#capacity = capacity
  }

  /** Push one value; returns false when the queue is closed or overflowed. */
  push(value: T): boolean {
    if (this.#closed) return false
    if (this.#values.length >= this.#capacity) {
      this.fail(new Error(`remote agent: session stream exceeded ${this.#capacity} buffered frames`))
      return false
    }
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false })
    } else {
      this.#values.push(value)
    }
    return true
  }

  /** Close gracefully after queued values are drained. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  /** Fail the queue, discarding buffered values and rejecting pending readers. */
  fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#failure = error
    this.#values.length = 0
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.#failure !== undefined) return Promise.reject(this.#failure)
    if (this.#closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  return(): Promise<IteratorResult<T>> {
    this.close()
    return Promise.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}
