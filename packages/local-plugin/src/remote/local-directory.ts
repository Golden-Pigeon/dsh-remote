/** Local folder browser used by the unified workspace-creation dialog. */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { LocalError } from '../errors.ts'

export interface LocalDirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly { readonly name: string; readonly path: string }[]
  readonly truncated: boolean
}

function normalize(path: string | undefined): string {
  const raw = (path ?? '').trim()
  if (raw === '' || raw === '~') return homedir()
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2))
  return resolve(raw)
}

/** List child directories of one local path. */
export async function listLocalDirectories(path?: string): Promise<LocalDirectoryListing> {
  const target = normalize(path)
  try {
    const names = await readdir(target)
    const entries: { name: string; path: string }[] = []
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      try {
        if ((await stat(resolve(target, name))).isDirectory()) {
          entries.push({ name, path: resolve(target, name) })
        }
      } catch {
        // A disappearing or unreadable child must not fail the whole listing.
      }
    }
    return {
      path: target,
      parent: dirname(target) || target,
      entries: entries.slice(0, 500),
      truncated: entries.length > 500,
    }
  } catch (error) {
    throw new LocalError('directory/unreadable', `could not read local directory ${target}: ${String(error)}`)
  }
}
