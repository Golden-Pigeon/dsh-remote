import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { listDirectories, listFile, readBytes, readText, statFile, watchFile } from '../src/files.ts'
import { RemoteTerminalManager, type TerminalChildProcess } from '../src/terminal.ts'

describe('remote files', () => {
  it('stats, reads, lists, and watches a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-files-'))
    try {
      const file = join(dir, 'sample.txt')
      await writeFile(file, 'one\ntwo\nthree\n')
      assert.equal((await statFile(file)).bytes, 14)
      assert.equal((await readText(file, 2, 1)).text, 'two')
      assert.equal(Buffer.from((await readBytes(file, 0, 4)).data, 'base64').toString(), 'one\n')
      assert.deepEqual((await listFile(dir)).entries[0]?.name, 'sample.txt')
      assert.equal((await listDirectories(dir)).entries.length, 0)
      const frames = []
      for await (const frame of watchFile(file, AbortSignal.timeout(3_000))) frames.push(frame)
      assert.equal(frames[0]?.kind, 'ready')
      assert.equal(frames[1]?.kind, 'change')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('remote terminal', () => {
  it('allocates a PTY, sends input, and streams output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-term-'))
    const manager = new RemoteTerminalManager()
    const controller = new AbortController()
    try {
      const info = manager.create({ id: 't1', cwd: dir, cols: 80, rows: 24 })
      assert.equal(info.state, 'running')
      const output: string[] = []
      const reader = (async () => {
        for await (const frame of manager.attach('t1', controller.signal)) {
          if (frame.type === 'output') output.push(frame.data)
        }
      })()
      await new Promise(resolve => setTimeout(resolve, 250))
      manager.input('t1', { type: 'write', data: 'printf "dsh-terminal-ok\\n"\n' })
      await new Promise(resolve => setTimeout(resolve, 700))
      assert.ok(output.join('').includes('dsh-terminal-ok'))
      manager.input('t1', { type: 'resize', cols: 100, rows: 30 })
      manager.close('t1')
      controller.abort()
      await reader
    } finally {
      manager.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

class FakePtyChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly control = new PassThrough()
  readonly stdio = [this.stdin, this.stdout, this.stderr, this.control] as const

  kill(): boolean {
    return true
  }
}

function fakeTerminal(child: FakePtyChild): RemoteTerminalManager {
  const manager = new RemoteTerminalManager({ spawn: () => child as unknown as TerminalChildProcess })
  manager.create({ id: 't1', cwd: tmpdir(), cols: 80, rows: 24 })
  return manager
}

describe('remote terminal teardown', () => {
  it('ignores stdio resets emitted while closing the PTY', () => {
    const child = new FakePtyChild()
    const manager = fakeTerminal(child)
    try {
      const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      for (const stream of [child.stdin, child.stdout, child.stderr, child.control]) {
        assert.doesNotThrow(() => stream.emit('error', reset))
      }
      assert.equal(manager.list()[0]?.state, 'running')
      manager.close('t1')
      assert.doesNotThrow(() => child.stdout.emit('error', reset))
    } finally {
      manager.dispose()
    }
  })

  it('marks a live PTY failed on a non-teardown stream error', () => {
    const child = new FakePtyChild()
    const manager = fakeTerminal(child)
    try {
      child.stdout.emit('error', new Error('read failed'))
      assert.equal(manager.list()[0]?.state, 'failed')
    } finally {
      manager.dispose()
    }
  })
})
