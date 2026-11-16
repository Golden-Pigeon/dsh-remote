/**
 * SSH client-configuration discovery.
 *
 * The Settings page offers the hosts this machine already knows about instead
 * of asking the user to retype an SSH destination. Discovery is read-only: it
 * parses `~/.ssh/config` (following `Include`) and asks `ssh -G` what an alias
 * finally resolves to. It never opens a connection and never provisions a
 * remote runtime.
 *
 * Two layers are deliberately separable:
 *
 * - {@link parseSshConfig} is pure text handling with an injected include
 *   loader, so the vocabulary rules are testable without a filesystem.
 * - {@link scanSshConfig} joins that with `ssh -G` resolution, whose runner is
 *   also injectable.
 *
 * Registration keeps the alias, not the resolved `user@host:port`: only the
 * alias carries `IdentityFile`, `ProxyJump`, `StrictHostKeyChecking`, and the
 * `Include`d files that made the host reachable in the first place. Resolved
 * values exist for display only.
 *
 * @module dsh-remote-local/ssh/config
 */

import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { parseSshTarget } from './target.ts'

const execFileAsync = promisify(execFile)

/** Guard rails so a pathological config cannot stall the Settings page. */
const MAX_INCLUDE_DEPTH = 4
const MAX_CONFIG_FILES = 32
const DEFAULT_CONCURRENCY = 4

/** One config file already read from disk. */
export interface SshConfigFile {
  readonly path: string
  readonly text: string
}

/**
 * Resolve one `Include` pattern to files.
 *
 * Production expands a glob and reads each match; tests return fixed content.
 * Implementations must not throw for a missing file.
 */
export type IncludeLoader = (pattern: string, baseDir: string) => Promise<readonly SshConfigFile[]>

/** A literal `Host` alias with whatever the config declares for it. */
export interface ScannedSshHost {
  readonly alias: string
  /** File the alias was declared in. */
  readonly source: string
  /** Declared `HostName`, which may still contain `%h` and friends. */
  readonly hostname: string | null
  readonly user: string | null
  readonly port: number | null
  /** Canonical destination, exactly the spelling `host/add` stores. */
  readonly canonical: string
  /** Whether `ssh -G` reports a jump host or proxy command. */
  readonly proxyJump: boolean
}

/** A `Host` pattern that cannot become a registered host. */
export interface SkippedSshHost {
  readonly alias: string
  readonly reason: 'wildcard' | 'unsupported'
}

/** Parsed config inventory. */
export interface ParsedSshConfig {
  readonly hosts: readonly ScannedSshHost[]
  readonly skipped: readonly SkippedSshHost[]
}

/** Mutable state shared by the recursive parse. */
interface ParseContext {
  readonly read: IncludeLoader
  readonly visited: Set<string>
  readonly aliases: Set<string>
  readonly skipped: Set<string>
  readonly hosts: ScannedSshHost[]
  readonly skips: SkippedSshHost[]
  files: number
}

/** One `Host` block being accumulated. */
interface HostBlock {
  readonly aliases: readonly string[]
  readonly source: string
  hostname: string | null
  user: string | null
  port: number | null
}

/** Remove one layer of matching single or double quotes. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1)
  }
  return value
}

/** Split one config line into a lowercase keyword and its raw value. */
export function splitConfigLine(line: string): { keyword: string; value: string } | null {
  const trimmed = line.trim()
  // OpenSSH treats `#` as a comment only at the start of a line; a mid-line `#`
  // is part of the value, so it must not be stripped.
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const separator = trimmed.search(/[\s=]/u)
  if (separator < 0) return { keyword: trimmed.toLowerCase(), value: '' }
  const keyword = trimmed.slice(0, separator).toLowerCase()
  let rest = trimmed.slice(separator).replace(/^\s*/u, '')
  if (rest.startsWith('=')) rest = rest.slice(1).replace(/^\s*/u, '')
  return { keyword, value: unquote(rest.trim()) }
}

/** Whether a `Host` pattern is a glob rather than a literal alias. */
export function isWildcardPattern(pattern: string): boolean {
  return /[*?!]/u.test(pattern)
}

/** Record one finished `Host` block. */
function closeBlock(block: HostBlock | null, context: ParseContext): void {
  if (block === null) return
  for (const alias of block.aliases) {
    if (context.aliases.has(alias) || context.skipped.has(alias)) continue
    if (isWildcardPattern(alias)) {
      context.skipped.add(alias)
      context.skips.push({ alias, reason: 'wildcard' })
      continue
    }
    // The same guard the registry applies, so the panel never offers a host the
    // add path would reject.
    let canonical: string
    try {
      canonical = parseSshTarget(alias).canonical
    } catch {
      context.skipped.add(alias)
      context.skips.push({ alias, reason: 'unsupported' })
      continue
    }
    context.aliases.add(alias)
    context.hosts.push({
      alias,
      source: block.source,
      hostname: block.hostname,
      user: block.user,
      port: block.port,
      canonical,
      // Filled in once `ssh -G` has run.
      proxyJump: false,
    })
  }
}

/**
 * Parse SSH client configuration text.
 *
 * Only literal `Host` aliases become candidates. `Host *` style defaults,
 * negations, and `Match` blocks contribute nothing, because they describe a
 * pattern rather than a machine you can connect to by name.
 */
export async function parseSshConfig(
  text: string,
  source: string,
  read: IncludeLoader,
  depth = 0,
): Promise<ParsedSshConfig> {
  const context: ParseContext = {
    read,
    visited: new Set([source]),
    aliases: new Set(),
    skipped: new Set(),
    hosts: [],
    skips: [],
    files: 1,
  }
  await parseInto(text, source, read, context, depth)
  return { hosts: context.hosts, skipped: context.skips }
}

async function parseInto(
  text: string,
  source: string,
  read: IncludeLoader,
  context: ParseContext,
  depth: number,
): Promise<void> {
  let block: HostBlock | null = null
  for (const line of text.split(/\r?\n/u)) {
    const entry = splitConfigLine(line)
    if (entry === null) continue
    const { keyword, value } = entry

    if (keyword === 'host') {
      closeBlock(block, context)
      block = {
        aliases: value.split(/\s+/u).filter(alias => alias !== ''),
        source,
        hostname: null,
        user: null,
        port: null,
      }
      continue
    }
    // `Match` ends the current Host context; its body is conditional and can
    // never declare a connectable alias.
    if (keyword === 'match') {
      closeBlock(block, context)
      block = null
      continue
    }
    if (keyword === 'include') {
      if (depth >= MAX_INCLUDE_DEPTH || value === '') continue
      const baseDir = dirname(source)
      for (const pattern of value.split(/\s+/u).filter(part => part !== '')) {
        const files = await read(pattern, baseDir).catch(() => [])
        for (const file of files) {
          if (context.files >= MAX_CONFIG_FILES) return
          if (context.visited.has(file.path)) continue
          context.visited.add(file.path)
          context.files += 1
          // Included hosts join the same inventory. Option values an included
          // file sets for the surrounding block are not merged back; only the
          // aliases it declares matter here, and `ssh -G` supplies the rest.
          await parseInto(file.text, file.path, read, context, depth + 1)
        }
      }
      continue
    }
    if (block === null) continue
    // First obtained value wins, matching ssh's own precedence.
    if (keyword === 'hostname' && block.hostname === null && value !== '') {
      block.hostname = value
      continue
    }
    if (keyword === 'user' && block.user === null && value !== '') {
      block.user = value
      continue
    }
    if (keyword === 'port' && block.port === null) {
      const port = Number(value)
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) block.port = port
    }
  }
  closeBlock(block, context)
}

/** Expand `~` and resolve a path expression against one base directory. */
export function expandSshPath(pattern: string, baseDir: string, home = homedir()): string {
  if (pattern === '~') return home
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) return join(home, pattern.slice(2))
  return isAbsolute(pattern) ? pattern : join(baseDir, pattern)
}

/** Convert one single-component glob into an anchored regular expression. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  const body = escaped.replace(/\*/gu, '[^\\\\/]*').replace(/\?/gu, '[^\\\\/]')
  return new RegExp(`^${body}$`, 'u')
}

/** The directory to list for a glob, and the pattern to match its entries. */
function splitGlob(pattern: string): { directory: string; match: RegExp } {
  const separator = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf('\\'))
  if (separator < 0) return { directory: '.', match: globToRegExp(pattern) }
  return { directory: pattern.slice(0, separator) || '/', match: globToRegExp(pattern.slice(separator + 1)) }
}

/**
 * Default include loader: expand the glob and read every match.
 *
 * A missing or unreadable file contributes nothing rather than failing the
 * scan, because a stale `Include` must not hide every other host.
 */
export function createIncludeLoader(home = homedir()): IncludeLoader {
  return async (pattern, baseDir) => {
    const resolved = expandSshPath(pattern, baseDir, home)
    const paths = /[*?]/u.test(resolved)
      ? await readGlob(resolved)
      : [resolved]
    const files: SshConfigFile[] = []
    for (const path of paths) {
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text !== null) files.push({ path, text })
    }
    return files
  }
}

async function readGlob(resolved: string): Promise<string[]> {
  const { directory, match } = splitGlob(resolved)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => !entry.isDirectory() && match.test(entry.name))
    .map(entry => join(directory, entry.name))
    .sort()
}

/** Run one `ssh` invocation; injectable so tests never touch the network. */
export type RunSsh = (args: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number }>

/** What `ssh -G` says one alias finally means. */
export interface ResolvedSshHost {
  readonly hostname: string
  readonly user: string | null
  readonly port: number | null
  readonly proxyJump: boolean
}

/**
 * Parse `ssh -G` output.
 *
 * The command prints every effective option as `key value`; only the first
 * occurrence of each key matters, matching how ssh itself resolves them.
 */
export function parseResolvedHost(stdout: string): ResolvedSshHost | null {
  let hostname: string | null = null
  let user: string | null = null
  let port: number | null = null
  let proxyJump = false
  for (const line of stdout.split(/\r?\n/u)) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim()
    if (key === 'hostname') {
      if (hostname === null && value !== '') hostname = value
      continue
    }
    if (key === 'user') {
      if (user === null && value !== '') user = value
      continue
    }
    if (key === 'port') {
      if (port !== null) continue
      const parsed = Number(value)
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) port = parsed
      continue
    }
    if ((key === 'proxyjump' || key === 'proxycommand') && value !== '' && value !== 'none') {
      proxyJump = true
    }
  }
  if (hostname === null) return null
  return { hostname, user, port, proxyJump }
}

/** Resolve one alias through `ssh -G`, or null when ssh cannot say. */
export async function resolveSshHost(alias: string, options: {
  readonly sshBinary: string
  readonly configPath: string | null
  readonly timeoutMs: number
  readonly runSsh: RunSsh
}): Promise<ResolvedSshHost | null> {
  const args = [...options.configPath === null ? [] : ['-F', options.configPath], '-G', alias]
  const result = await options.runSsh(args).catch(() => null)
  if (result === null || result.code !== 0) return null
  return parseResolvedHost(result.stdout)
}

/** Scan options. */
export interface SshScanOptions {
  /** Explicit config file, or null for `~/.ssh/config`. */
  readonly configPath: string | null
  readonly sshBinary: string
  readonly timeoutMs: number
  readonly homeDir?: string
  readonly runSsh?: RunSsh
  readonly loadInclude?: IncludeLoader
  readonly concurrency?: number
}

/** Discovery outcome, before it is matched against the registry. */
export interface SshScanResult {
  readonly scannedAt: string
  readonly configFiles: readonly string[]
  readonly hosts: readonly ScannedSshHost[]
  readonly skipped: readonly SkippedSshHost[]
  /** Set when the root config could not be read at all. */
  readonly error: string | null
}

/** Default `ssh` runner. */
export function createSshRunner(options: {
  readonly sshBinary: string
  readonly timeoutMs: number
}): RunSsh {
  return async args => {
    try {
      const result = await execFileAsync(options.sshBinary, [...args], {
        timeout: options.timeoutMs,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      })
      return { stdout: result.stdout, stderr: result.stderr, code: 0 }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number }
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        code: typeof failure.code === 'number' ? failure.code : 1,
      }
    }
  }
}

/**
 * Scan the local SSH client configuration for usable hosts.
 *
 * This touches only local files and the local `ssh` binary in `-G` mode, which
 * prints configuration without connecting. Nothing here may start a tunnel or
 * provision a remote host; that stays in the registry's connect path.
 */
export async function scanSshConfig(options: SshScanOptions): Promise<SshScanResult> {
  const home = options.homeDir ?? homedir()
  const configPath = options.configPath ?? join(home, '.ssh', 'config')
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    // No config file simply means no candidates; that is not an error.
    const empty: SshScanResult = {
      scannedAt: new Date().toISOString(),
      configFiles: [],
      hosts: [],
      skipped: [],
      error: failure.code === 'ENOENT' ? null : `cannot read ${configPath}: ${failure.message}`,
    }
    return empty
  }

  const read = options.loadInclude ?? createIncludeLoader(home)
  const parsed = await parseSshConfig(text, configPath, read)
  const runSsh = options.runSsh ?? createSshRunner({ sshBinary: options.sshBinary, timeoutMs: options.timeoutMs })
  const hosts = await mapWithLimit(parsed.hosts, options.concurrency ?? DEFAULT_CONCURRENCY, async host => {
    const resolved = await resolveSshHost(host.alias, {
      sshBinary: options.sshBinary,
      configPath: options.configPath,
      timeoutMs: options.timeoutMs,
      runSsh,
    })
    // A failed resolution is not fatal: the declared values still describe the
    // host well enough to display, and the real connection resolves it anyway.
    return resolved === null
      ? host
      : { ...host, hostname: resolved.hostname, user: resolved.user, port: resolved.port, proxyJump: resolved.proxyJump }
  })

  return {
    scannedAt: new Date().toISOString(),
    configFiles: [...new Set(hosts.map(host => host.source))],
    hosts,
    skipped: parsed.skipped,
    error: null,
  }
}

/** Run `fn` over every item with a bounded number of concurrent workers. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
