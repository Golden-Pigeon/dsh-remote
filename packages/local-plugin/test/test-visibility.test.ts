import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { isTestHidden, loadTestVisibility } from '../src/mirror/test-visibility.ts'

describe('test visibility manifest', () => {
  let dir = ''
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-remote-visibility-')) })
  after(async () => { if (dir !== '') await rm(dir, { recursive: true, force: true }) })

  it('matches hidden ids and path prefixes only on segment boundaries', () => {
    const visibility = { hiddenPaths: ['/tmp/dsh-tests'], hiddenWorkspaceIds: ['ws-hidden'] }
    assert.equal(isTestHidden('/tmp/dsh-tests', 'other', visibility), true)
    assert.equal(isTestHidden('/tmp/dsh-tests/case-1', 'other', visibility), true)
    assert.equal(isTestHidden('/tmp/dsh-tests-other', 'other', visibility), false)
    assert.equal(isTestHidden('/tmp/project', 'ws-hidden', visibility), true)
  })

  it('loads a manifest and treats malformed input as empty', async () => {
    const file = join(dir, 'test-visibility.json')
    await writeFile(file, JSON.stringify({ hiddenPaths: ['/tmp/dsh-tests'], hiddenWorkspaceIds: ['ws-hidden'] }))
    assert.deepEqual(await loadTestVisibility(dir), {
      hiddenPaths: ['/tmp/dsh-tests'],
      hiddenWorkspaceIds: ['ws-hidden'],
    })
    await writeFile(file, '{not json')
    assert.deepEqual(await loadTestVisibility(dir), { hiddenPaths: [], hiddenWorkspaceIds: [] })
  })
})
