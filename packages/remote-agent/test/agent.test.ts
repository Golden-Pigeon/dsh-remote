import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  isLoopbackAddress,
  isValidToken,
  mintToken,
  parseBearer,
  tokensEqual,
} from '../src/auth.ts'
import { resolveConfig, resolveDshHome, resolveUserPath } from '../src/config.ts'
import {
  findWorkspaceId,
  projectSession,
  projectWorkspace,
  takeTail,
  toWireEvent,
} from '../src/projection.ts'
import { AsyncQueue } from '../src/queue.ts'
import {
  openState,
  parseState,
  withListener,
  withStopped,
  writeState,
} from '../src/state.ts'
import { AGENT_VERSION } from '../src/version.ts'

const PACKAGE_VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-'))
  tempDirs.push(dir)
  return dir
}

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('version', () => {
  it('keeps the runtime constant aligned with the package manifest', () => {
    assert.equal(AGENT_VERSION, PACKAGE_VERSION)
  })
})

describe('auth', () => {
  it('mints a usable token and compares in constant time', () => {
    const token = mintToken()
    assert.equal(token.length, 64)
    assert.ok(isValidToken(token))
    assert.ok(tokensEqual(token, token))
    assert.equal(tokensEqual(token, `${token}x`), false)
  })

  it('parses bearer headers and recognizes loopback peers', () => {
    assert.equal(parseBearer('Bearer abc'), 'abc')
    assert.equal(parseBearer('bearer  abc '), 'abc')
    assert.equal(parseBearer(undefined), undefined)
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackAddress('10.0.0.2'), false)
  })
})

describe('config', () => {
  it('honors DSH_HOME and expands tilde paths', () => {
    assert.equal(resolveDshHome({ DSH_HOME: '/srv/dsh' }), '/srv/dsh')
    assert.equal(resolveUserPath('~/x', '/home/u'), '/home/u/x')
    assert.equal(resolveUserPath('', '/home/u'), '/home/u/remote-agent/agent.json')
    assert.equal(resolveUserPath('/abs/x', '/home/u'), '/abs/x')
  })

  it('clamps the default snapshot size to the maximum', () => {
    const resolved = resolveConfig({ defaultSnapshotEvents: 9_000, maxSnapshotEvents: 100 })
    assert.equal(resolved.defaultSnapshotEvents, 100)
    assert.equal(resolved.maxSnapshotEvents, 100)
  })
})

describe('state file', () => {
  it('atomically writes mode 0600 and reuses the token', async () => {
    const dir = await tempDir()
    const file = join(dir, 'agent.json')
    const opened = await openState(file, '', { agentVersion: AGENT_VERSION, dshVersion: '0.2.1-rc.2' })
    const bound = withListener(opened.state, { port: 41234, url: 'http://127.0.0.1:41234' })
    await writeState(file, bound)

    const mode = (await stat(file)).mode & 0o777
    assert.equal(mode, 0o600)
    const parsed = parseState(await readFile(file, 'utf8'))
    assert.equal(parsed.token, opened.token)
    assert.equal(parsed.port, 41234)

    const reopened = await openState(file, '', { agentVersion: AGENT_VERSION, dshVersion: '0.2.1-rc.2' })
    assert.equal(reopened.token, opened.token)
    assert.equal(reopened.fileExisted, true)

    const stopped = withStopped(parsed, '2026-01-01T00:00:00.000Z')
    assert.equal(stopped.port, null)
    assert.equal(stopped.stoppedAt, '2026-01-01T00:00:00.000Z')
  })

  it('honors an explicitly configured token', async () => {
    const dir = await tempDir()
    const file = join(dir, 'agent.json')
    const token = 'configured-token-1234'
    const opened = await openState(file, token, { agentVersion: AGENT_VERSION, dshVersion: 'x' })
    assert.equal(opened.token, token)
  })

  it('rejects malformed state instead of silently rotating the token', () => {
    assert.throws(() => parseState('{"version":1,"token":"x"}'), /token/)
    assert.throws(() => parseState('not json'), /valid JSON/)
  })
})

describe('projection', () => {
  it('projects workspaces and session summaries', () => {
    const workspace = projectWorkspace({
      id: 'w1',
      path: '/srv/project',
      title: 'project',
      sessionIds: ['s1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    assert.deepEqual(workspace, {
      workspaceId: 'w1',
      path: '/srv/project',
      title: 'project',
      sessionIds: ['s1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    assert.equal(findWorkspaceId([{
      id: 'w1',
      path: '/srv/project',
      title: 'project',
      sessionIds: ['s1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }], 's1'), 'w1')

    const summary = projectSession({
      header: { id: 's1', createdAt: 1, cwd: '/srv/project' },
      live: true,
      eventCount: 3,
      workspaceId: 'w1',
    })
    assert.equal(summary.sessionId, 's1')
    assert.equal(summary.workspaceId, 'w1')
    assert.equal(summary.live, true)

    const subagent = projectSession({
      header: { id: 's2', createdAt: 2, cwd: '/srv/project', origin: 'subagent', parentSession: 's1' },
      live: true,
      eventCount: 1,
      workspaceId: 'w1',
    })
    assert.equal(subagent.origin, 'subagent')
    assert.equal(subagent.parentSession, 's1')
  })

  it('takes the newest tail and converts events without reshaping data', () => {
    assert.deepEqual(takeTail([1, 2, 3], 2), { items: [2, 3], truncated: true })
    assert.deepEqual(takeTail([1], 2), { items: [1], truncated: false })
    assert.deepEqual(toWireEvent({ seq: 4, type: 'turn/start', time: 10, data: { turn: 1 } }), {
      seq: 4,
      type: 'turn/start',
      time: 10,
      data: { turn: 1 },
    })
  })
})

describe('async queue', () => {
  it('delivers values and closes', async () => {
    const queue = new AsyncQueue<number>(2)
    queue.push(1)
    queue.push(2)
    assert.deepEqual(await queue.next(), { value: 1, done: false })
    assert.deepEqual(await queue.next(), { value: 2, done: false })
    queue.close()
    assert.deepEqual(await queue.next(), { value: undefined, done: true })
  })

  it('fails on overflow', async () => {
    const queue = new AsyncQueue<number>(1)
    queue.push(1)
    assert.equal(queue.push(2), false)
    await assert.rejects(queue.next(), /exceeded 1/)
  })
})
