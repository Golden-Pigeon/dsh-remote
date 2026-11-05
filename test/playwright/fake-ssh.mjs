#!/usr/bin/env node
import net from 'node:net'
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const logFile = process.env.DSH_REMOTE_FAKE_LOG
const log = (text) => { if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`) }
log(`args ${args.join(' ')}`)
const stateFile = process.env.DSH_REMOTE_FAKE_STATE
if (!stateFile) {
  process.stderr.write('fake-ssh: DSH_REMOTE_FAKE_STATE is not set\n')
  process.exit(2)
}
if (args.includes('-O')) process.exit(0)
const redirect = args.indexOf('-L')
if (redirect < 0) {
  const state = readFileSync(stateFile, 'utf8'); log(`state ${state.slice(0, 80)}`); process.stdout.write(state)
  process.exit(0)
}
const spec = args[redirect + 1]
if (spec === undefined) process.exit(2)
const [, localPortText, , remotePortText] = spec.split(':')
const localPort = Number(localPortText)
const remotePort = Number(remotePortText)
if (!Number.isInteger(localPort) || !Number.isInteger(remotePort)) process.exit(2)
const server = net.createServer(client => {
  const upstream = net.connect(remotePort, '127.0.0.1')
  client.pipe(upstream)
  upstream.pipe(client)
  const close = () => { client.destroy(); upstream.destroy() }
  client.once('error', close)
  upstream.once('error', close)
  client.once('close', () => upstream.destroy())
  upstream.once('close', () => client.destroy())
})
server.listen(localPort, '127.0.0.1', () => log(`tunnel ${localPort}->${remotePort}`))
const shutdown = () => server.close(() => process.exit(0))
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
