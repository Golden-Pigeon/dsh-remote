/**
 * Read-only remote directory browser used by the workspace creation UI.
 * It reuses the host's SSH transport and runs a tiny Python lister remotely.
 *
 * @module dsh-remote-local/remote/directory
 */

import { spawn } from 'node:child_process'
import { LocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'

const LISTER = String.raw`
import json, os, sys
raw = sys.argv[1] if len(sys.argv) > 1 else '~'
path = os.path.abspath(os.path.expanduser(raw))
parent = os.path.dirname(path.rstrip('/')) or '/'
entries = []
with os.scandir(path) as it:
    for entry in it:
        try:
            if not entry.is_dir(follow_symlinks=True):
                continue
            entries.append({'name': entry.name, 'path': os.path.join(path, entry.name)})
        except OSError:
            continue
entries.sort(key=lambda item: item['name'].lower())
print(json.dumps({
    'path': path,
    'parent': parent,
    'entries': entries[:500],
    'truncated': len(entries) > 500,
}))
`

export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
}

export interface RemoteDirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly RemoteDirectoryEntry[]
  readonly truncated: boolean
}

/** List child directories of one remote path. */
export async function listRemoteDirectories(
  hosts: RemoteHostsService,
  hostId: string,
  path = '~',
): Promise<RemoteDirectoryListing> {
  const ssh = hosts.sshFor(hostId)
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10000',
    ...ssh.port === null ? [] : ['-p', String(ssh.port)],
    ssh.target,
    'python3', '-c', `'import base64;exec(base64.b64decode("${Buffer.from(LISTER).toString('base64')}"))'`,
    path,
  ]
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(ssh.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new LocalError('directory/unreadable', stderr.trim() || `remote directory listing exited with ${String(code)}`))
    })
  })
  try {
    const parsed = JSON.parse(output) as RemoteDirectoryListing
    if (typeof parsed.path !== 'string' || typeof parsed.parent !== 'string' || !Array.isArray(parsed.entries)) {
      throw new Error('invalid directory listing')
    }
    return parsed
  } catch (error) {
    throw new LocalError('directory/unreadable', `remote directory listing returned invalid JSON: ${String(error)}`)
  }
}
