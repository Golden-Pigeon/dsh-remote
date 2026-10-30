import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import {
  AGENT_ROUTES,
  PROTOCOL_VERSION,
  RemoteAgentClient,
  directoryListPath,
  fileWatchPath,
  matchAgentRoute,
  terminalAttachPath,
  terminalInputPath,
} from '../src/index.ts'

function envelope(data: unknown): string {
  return JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: new Date().toISOString(), data })
}

describe('file and terminal routes', () => {
  it('matches fixed and dynamic routes', () => {
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.fileStat), { kind: 'file-stat' })
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.fileWatch), { kind: 'file-watch' })
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.directories), { kind: 'directory-list' })
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.terminals), { kind: 'terminals' })
    assert.deepEqual(matchAgentRoute(terminalAttachPath('t 1')), { kind: 'terminal-attach', terminalId: 't 1' })
    assert.deepEqual(matchAgentRoute(terminalInputPath('t1')), { kind: 'terminal-input', terminalId: 't1' })
    assert.equal(new URL(fileWatchPath('/a b'), 'http://x').searchParams.get('path'), '/a b')
    assert.equal(new URL(directoryListPath('~'), 'http://x').searchParams.get('path'), '~')
  })
})

describe('RemoteAgentClient file and terminal calls', () => {
  let server: Server
  let baseUrl: string
  const token = 'test-token'

  before(async () => {
    server = createServer((req, res) => {
      if (req.headers['x-dsh-remote-protocol'] === undefined || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, protocolVersion: PROTOCOL_VERSION, serverTime: new Date().toISOString(), error: { code: 'auth/invalid', message: 'bad token', retryable: false } }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = matchAgentRoute(url.pathname)
      if (route?.kind === 'file-stat') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ absolutePath: '/x', version: '1:2', bytes: 2 }))
        return
      }
      if (route?.kind === 'file-list') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ path: '/x', entries: [{ name: 'a', type: 'file', size: 2 }], truncated: false }))
        return
      }
      if (route?.kind === 'file-read') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ absolutePath: '/x', version: '1:2', bytes: 2, offset: 1, lines: 1, text: 'a', eof: true }))
        return
      }
      if (route?.kind === 'file-bytes') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ absolutePath: '/x', version: '1:2', bytes: 2, offset: 0, data: 'YQ==', eof: true }))
        return
      }
      if (route?.kind === 'directory-list') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ path: '/x', parent: '/', entries: [{ name: 'a', path: '/x/a' }], truncated: false }))
        return
      }
      if (route?.kind === 'file-watch') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: file\ndata: ${JSON.stringify({ kind: 'ready' })}\n\n`)
        res.write(`event: file\ndata: ${JSON.stringify({ kind: 'change', change: { absolutePath: '/x', version: 'v2' } })}\n\n`)
        res.end()
        return
      }
      if (route?.kind === 'terminals' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'bash', args: [] }, cwd: '/x', cols: 80, rows: 24, state: 'running', exitCode: null }))
        return
      }
      if (route?.kind === 'terminals') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ terminals: [{ id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'bash', args: [] }, cwd: '/x', cols: 80, rows: 24, state: 'running', exitCode: null }] }))
        return
      }
      if (route?.kind === 'terminal-input' || route?.kind === 'terminal-rename' || route?.kind === 'terminal-close') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(envelope({ accepted: true }))
        return
      }
      if (route?.kind === 'terminal-attach') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: frame\ndata: ${JSON.stringify({ type: 'snapshot', sequence: 0, screen: '', info: { id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'bash', args: [] }, cwd: '/x', cols: 80, rows: 24, state: 'running', exitCode: null }, writable: true })}\n\n`)
        res.write(`event: frame\ndata: ${JSON.stringify({ type: 'output', sequence: 1, data: 'hello' })}\n\n`)
        res.write(`event: frame\ndata: ${JSON.stringify({ type: 'state', info: { id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'bash', args: [] }, cwd: '/x', cols: 80, rows: 24, state: 'exited', exitCode: 0 }, writable: false })}\n\n`)
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, protocolVersion: PROTOCOL_VERSION, serverTime: new Date().toISOString(), error: { code: 'route/not-found', message: 'not found', retryable: false } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => new Promise<void>(resolve => server.close(() => resolve())))

  it('round-trips file and directory APIs', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    assert.equal((await client.fileStat('/x')).version, '1:2')
    assert.equal((await client.fileList('/x')).entries[0]?.name, 'a')
    assert.equal((await client.fileRead('/x')).text, 'a')
    assert.equal((await client.fileBytes('/x')).data, 'YQ==')
    assert.equal((await client.listDirectories('~')).entries[0]?.path, '/x/a')
    const frames = []
    for await (const frame of client.followFileChanges('/x', new AbortController().signal)) frames.push(frame)
    assert.deepEqual(frames.map(frame => frame.kind), ['ready', 'change'])
  })

  it('round-trips terminal APIs', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    assert.equal((await client.createTerminal({ id: 't1', cwd: '/x' })).id, 't1')
    assert.equal((await client.listTerminals())[0]?.id, 't1')
    await client.terminalInput('t1', { type: 'write', data: 'echo hi\n' })
    await client.renameTerminal('t1', 'new')
    await client.closeTerminal('t1')
    const frames = []
    for await (const frame of client.attachTerminal('t1', new AbortController().signal)) frames.push(frame)
    assert.deepEqual(frames.map(frame => frame.type), ['snapshot', 'output', 'state'])
  })
})
