/**
 * Localize failures that crossed the host RPC boundary.
 *
 * Raw host messages are intentionally not rendered: they are logs/tool text and
 * may be written in the host's development language, not the user's DSH
 * locale. The stable `ui` key, then the error code, then the caller fallback are
 * used in that order.
 *
 * @module dsh-remote-local/client/errors
 */

import type { UiText } from '../messages.ts'
import type { CopyKey, Translate } from './locale.ts'
import { RemoteUiError } from './api.ts'

const CODE_KEYS: Record<string, CopyKey> = {
  'request/invalid': 'error.requestInvalid',
  'host/invalid': 'error.hostInvalid',
  'host/duplicate': 'error.hostDuplicate',
  'host/not-found': 'error.hostNotFound',
  'host/not-connected': 'error.hostNotConnected',
  'host/connect-failed': 'error.hostConnectFailed',
  'ssh/probe-failed': 'error.sshProbeFailed',
  'ssh/tunnel-failed': 'error.sshTunnelFailed',
  'agent/unavailable': 'error.agentUnavailable',
  'agent/error': 'error.agentError',
  'directory/unreadable': 'error.directoryUnreadable',
  'internal': 'error.internal',
}

/** Render one stable UI message, replacing `{param}` placeholders. */
export function formatUiText(t: Translate, text: UiText): string {
  let value = t(text.key as CopyKey)
  for (const [key, parameter] of Object.entries(text.params ?? {})) {
    value = value.replaceAll(`{${key}}`, String(parameter))
  }
  return value
}

/** Render one failure without leaking host-side prose. */
export function localizedError(t: Translate, failure: unknown, fallback: string): string {
  if (failure instanceof RemoteUiError) {
    if (failure.ui !== undefined) return formatUiText(t, failure.ui)
    const key = CODE_KEYS[failure.code]
    if (key !== undefined) return t(key)
  }
  return fallback
}
