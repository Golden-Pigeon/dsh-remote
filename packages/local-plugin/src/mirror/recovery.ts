/**
 * Decision helper for a remote turn abandoned by a host restart.
 *
 * @module dsh-remote-local/mirror/recovery
 */

/** The subset of the local `turnBoundary` projection used by recovery. */
export interface AbandonedTurnBoundary {
  readonly openTurnStartSeq?: unknown
}

/** Build the local `turn/end` event for an abandoned remote turn. */
export function abandonedTurnEnd(
  boundary: AbandonedTurnBoundary | undefined,
  turn: number,
): { turn: number; reason: { kind: 'aborted'; reason: { kind: 'disposed' } } } | undefined {
  // A prompt may be accepted before the remote appends `turn/start`; only a
  // turn the mirrored log actually opened can be closed here.
  if (typeof boundary?.openTurnStartSeq !== 'number') return undefined
  return {
    turn,
    reason: { kind: 'aborted', reason: { kind: 'disposed' } },
  }
}
