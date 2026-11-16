import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { aliasGroupKey, mergeAliasGroups, type AliasGroupMember } from '../src/ssh/alias-groups.ts'

function member(overrides: Partial<AliasGroupMember> & { alias: string }): AliasGroupMember {
  return {
    canonical: overrides.alias,
    hostname: '21.91.123.76',
    user: 'weyoungli',
    port: 36000,
    source: '/home/u/.ssh/config',
    proxyJump: false,
    ...overrides,
  }
}

describe('SSH alias grouping', () => {
  it('merges aliases that resolve to the same machine', () => {
    // `Host devcloud_64g_weyoungli cloud64` on one line.
    const groups = mergeAliasGroups([
      member({ alias: 'devcloud_64g_weyoungli' }),
      member({ alias: 'cloud64' }),
    ])
    assert.equal(groups.length, 1)
    // The longer alias is the descriptive one, so it leads.
    assert.equal(groups[0]?.alias, 'devcloud_64g_weyoungli')
    assert.deepEqual(groups[0]?.aliases, ['cloud64'])
  })

  it('keeps different machines apart', () => {
    const groups = mergeAliasGroups([
      member({ alias: 'cloud64', hostname: '21.91.123.76', user: 'weyoungli' }),
      member({ alias: 'cloud32', hostname: '9.135.225.137', user: 'weyoungli' }),
    ])
    assert.equal(groups.length, 2)
    assert.deepEqual(groups.map(group => group.alias), ['cloud64', 'cloud32'])
  })

  it('distinguishes machines that differ only by user', () => {
    // Same address, two accounts: genuinely different destinations.
    const groups = mergeAliasGroups([
      member({ alias: 'devcloud_64g_user00', user: 'user00' }),
      member({ alias: 'devcloud_64g_weyoungli', user: 'weyoungli' }),
    ])
    assert.equal(groups.length, 2)
  })

  it('distinguishes machines that differ only by port', () => {
    const groups = mergeAliasGroups([
      member({ alias: 'a', port: 36000 }),
      member({ alias: 'b', port: 36001 }),
    ])
    assert.equal(groups.length, 2)
  })

  it('treats a bare alias as its own destination', () => {
    // No HostName means ssh connects to the alias name itself, so two bare
    // aliases are two different machines even though both resolve "unset".
    const groups = mergeAliasGroups([
      member({ alias: 'alpha', hostname: null, port: null, user: null }),
      member({ alias: 'beta', hostname: null, port: null, user: null }),
    ])
    assert.equal(groups.length, 2)
  })

  it('orders the rest of the aliases shortest first', () => {
    const groups = mergeAliasGroups([
      member({ alias: 'nat' }),
      member({ alias: 'docker_os4_native1_user00' }),
      member({ alias: 'native1' }),
    ])
    assert.equal(groups.length, 1)
    assert.equal(groups[0]?.alias, 'docker_os4_native1_user00')
    assert.deepEqual(groups[0]?.aliases, ['nat', 'native1'])
  })

  it('preserves first-appearance order', () => {
    const groups = mergeAliasGroups([
      member({ alias: 'alpha', hostname: '1.1.1.1' }),
      member({ alias: 'bravo', hostname: '2.2.2.2' }),
      // A sibling for alpha: its longer spelling becomes the primary, but the
      // group still occupies alpha's position in the list.
      member({ alias: 'alpha-longer', hostname: '1.1.1.1' }),
    ])
    assert.deepEqual(groups.map(group => group.alias), ['alpha-longer', 'bravo'])
    assert.deepEqual(groups[0]?.aliases, ['alpha'])
  })

  it('keeps a lone alias unlabelled', () => {
    const groups = mergeAliasGroups([member({ alias: 'solo' })])
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0]?.aliases, [])
  })

  it('builds a key from the resolved target, not the alias text', () => {
    // The bug this replaces: `canonical` equals the alias, so aliases that
    // reach the same machine never compared equal.
    const left = aliasGroupKey(member({ alias: 'cloud64' }))
    const right = aliasGroupKey(member({ alias: 'devcloud_64g_weyoungli' }))
    assert.equal(left, right)
    assert.notEqual(
      aliasGroupKey(member({ alias: 'x', user: 'user00' })),
      aliasGroupKey(member({ alias: 'x', user: 'weyoungli' })),
    )
  })

  it('carries the shared connection facts on the group', () => {
    const groups = mergeAliasGroups([
      member({ alias: 'short' }),
      member({ alias: 'a-much-longer-alias' }),
    ])
    const group = groups[0]!
    assert.equal(group.value.hostname, '21.91.123.76')
    assert.equal(group.value.user, 'weyoungli')
    assert.equal(group.value.port, 36000)
  })
})
