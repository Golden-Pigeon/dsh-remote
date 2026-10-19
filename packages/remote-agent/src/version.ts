/**
 * Package/runtime version discovery.
 *
 * @module dsh-remote-agent/version
 */

import { createRequire } from 'node:module'

/** Keep in sync with package.json; a unit test enforces it. */
export const AGENT_VERSION = '0.2.5'

/** Plugin row name (also the bundle patch id). */
export const AGENT_NAME = '@goldenpigeon/dsh-remote-agent'

/** Resolve the DSH runtime version without failing plugin startup. */
export function resolveDshVersion(): string {
  const fromEnv = process.env.DSH_CLIENT_VERSION ?? process.env.DSH_VERSION
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('@deepseek-ai/dsh/package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}
