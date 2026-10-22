/**
 * Coalesce concurrent work that shares one key.
 *
 * Mirror creation is check-then-act across several awaits (workspace listing,
 * session listing, snapshot fetch). A periodic sync and an on-demand
 * `host/session/create` can both pass the "no mapping yet" check and each
 * create a local Session for the same remote Session. Running the creation
 * through a per-key in-flight table guarantees one creator and lets every
 * caller share its result.
 *
 * @module dsh-remote-local/mirror/inflight
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
