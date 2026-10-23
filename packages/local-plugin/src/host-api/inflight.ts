/**
 * Coalesce concurrent work that shares one key.
 *
 * The host API's `host/session/create` endpoint is the only place that mints a
 * remote Session for a local workspace row. A slow SSH tunnel makes the round
 * trip long enough for the user to click the row's New Session action again;
 * without a per-key in-flight table each click starts another remote Session.
 * Sharing one promise per key keeps the burst to a single create.
 *
 * @module dsh-remote-local/host-api/inflight
 */

/** Run `task` once per key while a previous run for that key is unsettled. */
export function singleFlight<K, V>(
  pending: Map<K, Promise<V>>,
  key: K,
  task: () => Promise<V>,
): Promise<V> {
  const running = pending.get(key)
  if (running !== undefined) return running
  // Defer the task by one microtask so the table is populated before any
  // synchronous body could re-enter it; a synchronous throw becomes a
  // rejection shared by every caller.
  const promise = Promise.resolve().then(task)
  pending.set(key, promise)
  const settle = (): void => {
    if (pending.get(key) === promise) pending.delete(key)
  }
  // `then` rather than `finally`: the cleanup never produces an unhandled
  // rejection, and callers still observe the original failure.
  void promise.then(settle, settle)
  return promise
}
