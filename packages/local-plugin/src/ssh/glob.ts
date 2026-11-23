/**
 * Expand SSH Include globs across every path segment.
 *
 * OpenSSH passes Include patterns through glob(3), so wildcards may appear in
 * directories as well as the final filename. The previous last-segment-only
 * matcher silently missed wildcard directories and bracket classes such as
 * host[0-9].conf.
 *
 * @module dsh-remote-local/ssh/glob
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Whether a path contains any glob metacharacter. */
export function hasGlob(pattern: string): boolean {
  return /[*?\[]/u.test(pattern)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Match one path segment; supports *, ?, and bracket classes. */
function segmentMatcher(segment: string): RegExp {
  let body = ''
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!
    if (char === '*') {
      body += '[^/]*'
      continue
    }
    if (char === '?') {
      body += '[^/]'
      continue
    }
    if (char === '[') {
      const close = segment.indexOf(']', index + 1)
      if (close <= index + 1) {
        body += '\\['
        continue
      }
      let content = segment.slice(index + 1, close)
      if (content.startsWith('!') || content.startsWith('^')) content = '^' + content.slice(1)
      content = content.replace(/\\/gu, '\\\\').replace(/\]/gu, '\\]')
      body += '[' + content + ']'
      index = close
      continue
    }
    body += escapeRegex(char)
  }
  try {
    return new RegExp('^' + body + '$', 'u')
  } catch {
    return new RegExp('^' + escapeRegex(segment) + '$', 'u')
  }
}

/**
 * Expand a resolved glob pattern, returning regular files in stable order.
 *
 * Missing directories are treated as no matches, matching ssh's config
 * Include behavior. Intermediate matches must be directories; the final
 * matches must be files.
 */
export async function expandGlobPaths(resolved: string): Promise<string[]> {
  const absolute = resolved.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(resolved)
  const parts = resolved.split(/[/\\]+/u).filter(part => part !== '')
  const walk = async (directory: string, index: number): Promise<string[]> => {
    if (index >= parts.length) return [directory]
    const part = parts[index]!
    if (!hasGlob(part)) {
      return walk(join(directory, part), index + 1)
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const matcher = segmentMatcher(part)
    const results: string[] = []
    for (const entry of entries) {
      if (!matcher.test(entry.name)) continue
      const next = join(directory, entry.name)
      if (index === parts.length - 1) {
        if (!entry.isDirectory()) results.push(next)
      } else if (entry.isDirectory()) {
        results.push(...await walk(next, index + 1))
      }
    }
    return results
  }
  const results = await walk(absolute ? '/' : '.', 0)
  return [...new Set(results)].sort()
}
