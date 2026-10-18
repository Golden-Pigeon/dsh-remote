/**
 * Stable host ids.
 *
 * An id is a human-readable slug plus a short hash of the canonical SSH
 * destination. Re-adding the same destination is therefore a duplicate, while
 * two aliases for the same machine remain distinct hosts (the user decides
 * whether to merge them).
 *
 * @module dsh-remote-local/hosts/id
 */

import { createHash } from 'node:crypto'

/** Whether a value is a valid host id. */
export function isHostId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)
}

/** Slugify a label or destination. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  return slug === '' ? 'host' : slug
}

/** Derive a stable id from one canonical destination. */
export function hostIdFor(canonicalDestination: string, label?: string): string {
  const hash = createHash('sha256').update(canonicalDestination).digest('hex').slice(0, 8)
  return `${slugify(label ?? canonicalDestination)}-${hash}`
}
