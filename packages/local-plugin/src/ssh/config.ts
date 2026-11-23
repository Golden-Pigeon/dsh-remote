/**
 * SSH client-config host inventory.
 *
 * This module only answers "which concrete host aliases does ~/.ssh/config
 * declare?" It never opens a connection, never evaluates Match conditions, and
 * never runs ProxyCommand/Match exec. The real ssh client performs those steps
 * when a host is connected, exactly as it does outside this plugin.
 *
 * Wildcard Host patterns are parsed so Include/Match context is not lost, but
 * they are never offered as selectable hosts. Aliases are intentionally not
 * merged: one `Host a b` line yields two entries, matching the registry's
 * existing "aliases remain distinct hosts" rule.
 *
 * @module dsh-remote-local/ssh/config
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { expandGlobPaths, hasGlob } from './glob.ts'
import { parseSshTarget } from './target.ts'

/** Guard rails for a pathological config/include graph. */
const MAX_INCLUDE_DEPTH = 8
const MAX_CONFIG_FILES = 64

/** One file already read from disk. */
export interface SshConfigFile {
  readonly path: string
  readonly text: string
}

/** Resolve one Include pattern to files. Missing files are not errors. */
export type IncludeLoader = (pattern: string, baseDir: string) => Promise<readonly SshConfigFile[]>

/** One concrete Host alias. */
export interface SshConfigHost {
  readonly alias: string
  readonly source: string
}

/** A Host pattern that is parsed but cannot be a selectable host. */
export interface SshConfigSkipped {
  readonly alias: string
  readonly reason: 'wildcard' | 'unsupported'
}

/** Parsed inventory. */
export interface ParsedSshConfig {
  readonly hosts: readonly SshConfigHost[]
  readonly skipped: readonly SshConfigSkipped[]
}

interface ParseContext {
  readonly read: IncludeLoader
  readonly visited: Set<string>
  readonly aliases: Set<string>
  readonly skippedAliases: Set<string>
  readonly hosts: SshConfigHost[]
  readonly skipped: SshConfigSkipped[]
  files: number
}

/** Split one config line into keyword and value. */
export function splitConfigLine(line: string): { keyword: string; value: string } | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  const separator = trimmed.search(/[\s=]/u)
  if (separator < 0) return { keyword: trimmed.toLowerCase(), value: '' }
  const keyword = trimmed.slice(0, separator).toLowerCase()
  let rest = trimmed.slice(separator).replace(/^\s*/u, '')
  if (rest.startsWith('=')) rest = rest.slice(1).replace(/^\s*/u, '')
  return { keyword, value: rest.trim() }
}

/** Whether a Host token is a pattern rather than a literal alias. */
export function isWildcardPattern(pattern: string): boolean {
  return /[*?!\[]/u.test(pattern)
}

/** Split a directive value into words, honouring quotes and backslashes. */
function splitWords(value: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const char of value) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      if (current !== '') {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') words.push(current)
  return words
}

function closeAliases(aliases: readonly string[], source: string, context: ParseContext): void {
  for (const alias of aliases) {
    if (alias === '' || context.aliases.has(alias) || context.skippedAliases.has(alias)) continue
    if (isWildcardPattern(alias)) {
      context.skippedAliases.add(alias)
      context.skipped.push({ alias, reason: 'wildcard' })
      continue
    }
    try {
      // The same guard the host registry uses; never offer a host that add
      // would reject.
      parseSshTarget(alias)
    } catch {
      context.skippedAliases.add(alias)
      context.skipped.push({ alias, reason: 'unsupported' })
      continue
    }
    context.aliases.add(alias)
    context.hosts.push({ alias, source })
  }
}

/** Parse one file and its Includes. Included files only contribute aliases. */
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
    skippedAliases: new Set(),
    hosts: [],
    skipped: [],
    files: 1,
  }
  await parseInto(text, source, read, context, depth)
  return { hosts: context.hosts, skipped: context.skipped }
}

async function parseInto(
  text: string,
  source: string,
  read: IncludeLoader,
  context: ParseContext,
  depth: number,
): Promise<void> {
  for (const line of text.split(/\r?\n/u)) {
    const entry = splitConfigLine(line)
    if (entry === null) continue
    const { keyword, value } = entry
    if (keyword === 'host') {
      closeAliases(splitWords(value), source, context)
      continue
    }
    if (keyword === 'match') {
      // Match bodies are conditional and cannot declare a host alias. ssh
      // itself evaluates them for a real connection.
      continue
    }
    if (keyword === 'include') {
      if (depth >= MAX_INCLUDE_DEPTH || value === '') continue
      const baseDir = dirname(source)
      for (const pattern of splitWords(value)) {
        const files = await read(pattern, baseDir).catch(() => [])
        for (const file of files) {
          if (context.files >= MAX_CONFIG_FILES) return
          if (context.visited.has(file.path)) continue
          context.visited.add(file.path)
          context.files += 1
          await parseInto(file.text, file.path, read, context, depth + 1)
        }
      }
    }
  }
}

/** Expand ~ and resolve an Include pattern against its declaring file. */
export function expandSshPath(pattern: string, baseDir: string, home = homedir()): string {
  if (pattern === '~') return home
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) return join(home, pattern.slice(2))
  return isAbsolute(pattern) ? pattern : join(baseDir, pattern)
}

/** Default Include loader; missing/unreadable files contribute nothing. */
export function createIncludeLoader(home = homedir()): IncludeLoader {
  return async (pattern, baseDir) => {
    const resolved = expandSshPath(pattern, baseDir, home)
    const paths = hasGlob(resolved) ? await expandGlobPaths(resolved) : [resolved]
    const files: SshConfigFile[] = []
    for (const path of paths) {
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text !== null) files.push({ path, text })
    }
    return files
  }
}

/** Automatically read and parse the local SSH client configuration. */
export async function scanSshHosts(options: {
  readonly configPath?: string
  readonly homeDir?: string
  readonly loadInclude?: IncludeLoader
} = {}): Promise<{ hosts: string[]; skipped: SshConfigSkipped[]; error: string | null }> {
  const home = options.homeDir ?? homedir()
  const configPath = options.configPath ?? join(home, '.ssh', 'config')
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    return {
      hosts: [],
      skipped: [],
      error: failure.code === 'ENOENT' ? null : `cannot read ${configPath}: ${failure.message}`,
    }
  }
  try {
    const parsed = await parseSshConfig(text, configPath, options.loadInclude ?? createIncludeLoader(home))
    return { hosts: parsed.hosts.map(host => host.alias), skipped: [...parsed.skipped], error: null }
  } catch (error) {
    return {
      hosts: [],
      skipped: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
