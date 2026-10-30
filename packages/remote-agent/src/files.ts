/**
 * Remote filesystem service backing the local workspace-files adapter.
 *
 * This module is deliberately path-agnostic: the local plugin already maps a
 * workspace anchor or a transcript's absolute path into the remote execution
 * world. The agent only enforces read-only semantics, size/page caps, and
 * stable errors.
 *
 * @module dsh-remote-agent/files
 */

import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  RemoteProtocolError,
  type RemoteDirectoryListing,
  type RemoteFileBytes,
  type RemoteFileEntry,
  type RemoteFileListing,
  type RemoteFileStat,
  type RemoteFileText,
  type RemoteFileWatchFrame,
} from '@dsh-remote/protocol'

const MAX_LINE = 32 * 1024
const MAX_PAGE = 1024 * 1024
const MAX_BYTES = 5_000_000
const MAX_ENTRIES = 2_000
const MAX_DIRECTORY_ENTRIES = 500
const WATCH_INTERVAL_MS = 2_000

function expand(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function statVersion(value: { mtimeNs: bigint; size: bigint }): string {
  return `${value.mtimeNs.toString()}:${value.size.toString()}`
}

async function fileStat(path: string): Promise<RemoteFileStat> {
  let value
  try {
    value = await stat(path, { bigint: true })
  } catch (error) {
    throw new RemoteProtocolError({ code: 'workspace-file/not-found', message: `not found: ${path}`, details: { path }, cause: error })
  }
  if (!value.isFile()) {
    throw new RemoteProtocolError({
      code: 'workspace-file/not-regular-file',
      message: `not a regular file: ${path}`,
      details: { path, kind: value.isDirectory() ? 'directory' : 'other' },
    })
  }
  return { absolutePath: path, version: statVersion(value), bytes: Number(value.size) }
}

/** Stat one regular file. */
export async function statFile(path: string): Promise<RemoteFileStat> {
  return fileStat(path)
}

/** Read one text page with the same line semantics as the old SSH helper. */
export async function readText(path: string, offsetInput?: number, limitInput?: number): Promise<RemoteFileText> {
  const info = await fileStat(path)
  const offset = Math.max(1, Math.trunc(offsetInput ?? 1))
  const limit = Math.max(1, Math.min(Math.trunc(limitInput ?? 200), 2_000))
  const lines: string[] = []
  let pageBytes = 0
  let index = 0
  let sawMore = false
  const input = createReadStream(path)
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    const iterator = reader[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      const raw = next.value
      index += 1
      if (index < offset) continue
      if (lines.length >= limit || pageBytes + Buffer.byteLength(raw) + 1 > MAX_PAGE) {
        sawMore = true
        break
      }
      const truncated = Buffer.byteLength(raw) > MAX_LINE
      const line = truncated ? `${raw.slice(0, MAX_LINE)}… [line truncated]` : raw
      if (line.includes('\u0000')) {
        throw new RemoteProtocolError({ code: 'workspace-file/not-text', message: `not UTF-8 text: ${path}`, details: { path } })
      }
      lines.push(line)
      pageBytes += Buffer.byteLength(line) + 1
      if (lines.length >= limit) {
        const more = await iterator.next()
        sawMore = more.done !== true
        break
      }
    }
  } finally {
    reader.close()
    input.destroy()
  }
  return {
    ...info,
    offset,
    lines: lines.length,
    text: lines.join('\n'),
    eof: !sawMore,
  }
}

/** Read one bounded byte window. */
export async function readBytes(path: string, offsetInput?: number, lengthInput?: number): Promise<RemoteFileBytes> {
  const info = await fileStat(path)
  const offset = Math.max(0, Math.trunc(offsetInput ?? 0))
  const length = Math.max(0, Math.min(Math.trunc(lengthInput ?? MAX_BYTES), MAX_BYTES))
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const result = await handle.read(buffer, 0, length, offset)
    return {
      ...info,
      offset,
      data: buffer.subarray(0, result.bytesRead).toString('base64'),
      eof: offset + result.bytesRead >= (info.bytes ?? 0),
    }
  } finally {
    await handle.close()
  }
}

/** List direct children of one directory. */
export async function listFile(path: string): Promise<RemoteFileListing> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new RemoteProtocolError({ code: 'workspace-file/not-found', message: `not found: ${path}`, details: { path }, cause: error })
  }
  const listed: RemoteFileEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    let type: RemoteFileEntry['type'] = 'other'
    let size: number | undefined
    try {
      const info = await stat(join(path, entry.name), { bigint: true })
      if (info.isDirectory()) type = 'directory'
      else if (info.isFile()) {
        type = 'file'
        size = Number(info.size)
      }
    } catch {
      // A disappearing child remains listed as `other`.
    }
    listed.push({ name: entry.name, type, ...size === undefined ? {} : { size } })
  }
  const truncated = listed.length > MAX_ENTRIES
  return { path, entries: listed.slice(0, MAX_ENTRIES), truncated }
}

/** List child directories for the workspace-creation picker. */
export async function listDirectories(rawPath = '~'): Promise<RemoteDirectoryListing> {
  const path = expand(rawPath)
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    throw new RemoteProtocolError({ code: 'directory/unreadable', message: `could not read remote directory ${path}`, details: { path }, cause: error })
  }
  const dirs: Array<{ name: string; path: string }> = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      if (!(await stat(join(path, entry.name))).isDirectory()) continue
      dirs.push({ name: entry.name, path: join(path, entry.name) })
    } catch {
      // Skip children that disappear during listing.
    }
  }
  return {
    path,
    parent: dirname(path) || path,
    entries: dirs.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: dirs.length > MAX_DIRECTORY_ENTRIES,
  }
}

/** Poll one target and emit current invalidation frames. */
export async function* watchFile(path: string, signal: AbortSignal): AsyncGenerator<RemoteFileWatchFrame> {
  yield { kind: 'ready' }
  let last = ''
  let absent = false
  while (!signal.aborted) {
    let version: string | undefined
    try {
      const info = await stat(path, { bigint: true })
      if (info.isFile()) version = statVersion(info)
      else {
        const listing = await listFile(path)
        version = `${listing.entries.length}:${listing.entries.map(entry => `${entry.name}:${entry.size ?? ''}`).join(',')}`
      }
    } catch {
      version = undefined
    }
    if (version === undefined) {
      if (!absent) {
        absent = true
        last = ''
        yield { kind: 'change', change: { absolutePath: path, absent: true } }
      }
    } else if (version !== last) {
      absent = false
      last = version
      yield { kind: 'change', change: { absolutePath: path, version } }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, WATCH_INTERVAL_MS))
  }
}
