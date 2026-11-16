/**
 * Merge SSH `Host` aliases that describe the same machine.
 *
 * One `Host` line can declare several names for one machine:
 *
 * ```sshconfig
 * Host devcloud_64g_weyoungli cloud64
 *   HostName 21.91.123.76
 *   User weyoungli
 *   Port 36000
 * ```
 *
 * The parser emits one entry per alias, because each alias is independently
 * resolvable by `ssh`. Presenting them as separate rows would offer the same
 * machine twice. Grouping has to happen after `ssh -G` resolution, because only
 * then do two aliases reveal that they point at the same target.
 *
 * @module dsh-remote-local/ssh/alias-groups
 */

/** The fields grouping needs, satisfied by a resolved scan entry. */
export interface AliasGroupMember {
  readonly alias: string
  readonly canonical: string
  /** Resolved name, or null when `ssh -G` could not answer. */
  readonly hostname?: string | null
  readonly user?: string | null
  readonly port?: number | null
  readonly source: string
  readonly proxyJump: boolean
}

/** One machine, with its primary alias and the rest beside it. */
export interface MergedAliasGroup<T extends AliasGroupMember> {
  /** Primary alias: the longest name, since it is the descriptive one. */
  readonly alias: string
  /** The remaining aliases, shortest first. */
  readonly aliases: readonly string[]
  /** A representative entry carrying the shared connection facts. */
  readonly value: T
}

/**
 * Identity of the machine an alias resolves to.
 *
 * Uses the resolved target rather than the alias text: aliases on one `Host`
 * line differ as strings but agree on every field here. A field left unset is
 * part of the key, so two bare aliases with no `HostName` stay distinct — they
 * really are different destinations to ssh.
 *
 * @param member - one resolved alias.
 * @returns a stable key shared by aliases that reach the same machine.
 */
export function aliasGroupKey(member: AliasGroupMember): string {
  return [
    member.user ?? '',
    member.hostname ?? member.alias,
    member.port ?? '',
  ].join('\u0000')
}

/**
 * Collapse aliases that reach the same machine into single groups.
 *
 * Order follows first appearance, so the list stays stable between scans.
 *
 * @param members - resolved aliases, in config order.
 * @returns one group per distinct machine.
 */
export function mergeAliasGroups<T extends AliasGroupMember>(
  members: readonly T[],
): MergedAliasGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const member of members) {
    const key = aliasGroupKey(member)
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, [member])
    else existing.push(member)
  }

  return [...groups.values()].map(group => {
    // Longest first: on a `Host a b` line the longer name is the descriptive
    // one, and it is what the user is more likely to recognise.
    const ordered = [...group].sort((left, right) => right.alias.length - left.alias.length)
    const primary = ordered[0] ?? group[0]!
    return {
      alias: primary.alias,
      // The tags read better shortest first, so the short handler-style names
      // sit together at the end of the line.
      aliases: ordered.slice(1)
        .map(entry => entry.alias)
        .sort((left, right) => left.length - right.length || left.localeCompare(right)),
      value: primary,
    }
  })
}
