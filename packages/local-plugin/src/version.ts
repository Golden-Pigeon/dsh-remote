/**
 * Local DSH version discovery and comparison.
 *
 * The remote agent reports the DSH version it runs under. Comparing it with
 * the local runtime lets Settings offer a manual upgrade when the remote is
 * older, without blocking the connection.
 *
 * @module dsh-remote-local/version
 */

import { createRequire } from 'node:module'

interface ParsedVersion {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly (string | number)[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

/** Parse a semver-shaped version; returns undefined for unknown formats. */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return undefined
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (core.some(part => !Number.isSafeInteger(part))) return undefined
  const prerelease = match[4] === undefined
    ? []
    : match[4].split('.').map(part => (/^\d+$/u.test(part) ? Number(part) : part))
  return { core, prerelease }
}

/** Compare two versions; fewer than zero means `left` is older. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (let index = 0; index < 3; index += 1) {
    const leftCore = a.core[index] as number
    const rightCore = b.core[index] as number
    if (leftCore !== rightCore) return leftCore < rightCore ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
      continue
    }
    if (typeof leftPart === 'number') return -1
    if (typeof rightPart === 'number') return 1
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** Describe a remote DSH version older than the local one. */
export function dshUpdateFor(
  remoteVersion: string | undefined,
  localVersion: string | undefined,
): { readonly remoteVersion: string; readonly localVersion: string } | undefined {
  if (remoteVersion === undefined || localVersion === undefined) return undefined
  const comparison = compareVersions(remoteVersion, localVersion)
  if (comparison === undefined || comparison >= 0) return undefined
  return { remoteVersion, localVersion }
}

/** Resolve the DSH runtime version hosting this plugin, without failing startup. */
export function resolveLocalDshVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.DSH_CLIENT_VERSION ?? env.DSH_VERSION
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  const require = createRequire(import.meta.url)
  for (const specifier of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-app-boot/package.json']) {
    try {
      const manifest = require(specifier) as { version?: unknown }
      if (typeof manifest.version === 'string' && manifest.version.trim() !== '') return manifest.version.trim()
    } catch {
      // The DSH package layout differs between source and bundled installs.
    }
  }
  return undefined
}
