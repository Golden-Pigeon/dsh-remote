/**
 * Discovery document written by a running remote agent.
 *
 * This is the one file the local plugin reads over SSH before it opens a
 * tunnel. It is intentionally small and contains only the token, the live
 * loopback port, and liveness metadata.
 *
 * @module @dsh-remote/protocol/discovery
 */

/** Current discovery-state schema version. */
export const DISCOVERY_STATE_VERSION = 1

/** One running agent's discovery state. */
export interface AgentDiscoveryState {
  readonly version: number
  readonly token: string
  readonly port: number | null
  readonly pid: number
  readonly startedAt: string
  readonly updatedAt: string
  readonly agentVersion: string
  readonly dshVersion: string
  readonly url: string | null
  readonly stoppedAt?: string
}

/** Whether a value is a structurally valid discovery state with a live port. */
export function isAgentDiscoveryState(value: unknown): value is AgentDiscoveryState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === DISCOVERY_STATE_VERSION
    && typeof record.token === 'string'
    && record.token.length >= 16
    && (record.port === null || (typeof record.port === 'number' && Number.isInteger(record.port) && record.port > 0))
    && typeof record.pid === 'number'
    && typeof record.startedAt === 'string'
    && typeof record.updatedAt === 'string'
    && typeof record.agentVersion === 'string'
    && typeof record.dshVersion === 'string'
    && (record.url === null || typeof record.url === 'string')
    && (record.stoppedAt === undefined || typeof record.stoppedAt === 'string')
}

/** Whether a discovery state describes a running listener. */
export function isAgentLive(state: AgentDiscoveryState): boolean {
  return state.port !== null && state.stoppedAt === undefined
}
