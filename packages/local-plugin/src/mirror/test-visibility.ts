/**
 * Test-only visibility manifest.
 *
 * This file lives only in a test DSH_HOME. It is intentionally not a Settings
 * option and not an agent tool: a test harness writes it before/after a run.
 *
 *   $DSH_HOME/remote/test-visibility.json
 *   { "hiddenPaths": ["/tmp/dsh-remote-tests"], "hiddenWorkspaceIds": ["..."] }
 *
 * Hidden paths/ids are not registered into the local workspace registry. Hiding
 * an already-mirrored workspace archives its local mirror Sessions and removes
 * the local row; removing the entry restores it from the remote log later.
 *
 * @module dsh-remote-local/mirror/test-visibility
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TestVisibility {
  readonly hiddenPaths: readonly string[]
  readonly hiddenWorkspaceIds: readonly string[]
}

const EMPTY: TestVisibility = { hiddenPaths: [], hiddenWorkspaceIds: [] }

/** Read the manifest; absent or malformed files disable test visibility. */
export async function loadTestVisibility(stateDir: string): Promise<TestVisibility> {
  try {
    const raw = await readFile(join(stateDir, 'test-visibility.json'), 'utf8')
    const parsed = JSON.parse(raw) as Partial<TestVisibility>
    return {
      hiddenPaths: Array.isArray(parsed.hiddenPaths)
        ? parsed.hiddenPaths.filter((item): item is string => typeof item === 'string')
        : [],
      hiddenWorkspaceIds: Array.isArray(parsed.hiddenWorkspaceIds)
        ? parsed.hiddenWorkspaceIds.filter((item): item is string => typeof item === 'string')
        : [],
    }
  } catch {
    return EMPTY
  }
}

/** Whether one remote workspace/path is hidden from local registration. */
export function isTestHidden(
  remotePath: string,
  remoteWorkspaceId: string,
  visibility: TestVisibility,
): boolean {
  if (visibility.hiddenWorkspaceIds.includes(remoteWorkspaceId)) return true
  const path = remotePath.trim().replace(/\/+$/u, '') || '/'
  return visibility.hiddenPaths.some((prefix) => {
    const root = prefix.trim().replace(/\/+$/u, '') || '/'
    return path === root || path.startsWith(`${root}/`)
  })
}
