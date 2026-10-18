/**
 * Local model credential proxy.
 *
 * The remote DSH process is configured with a per-host proxy token and a base
 * URL that points at a reverse SSH tunnel. Requests arrive here over the
 * tunnel after token validation; the proxy then injects the real local API
 * key and forwards to the provider. The key never leaves the local machine.
 *
 * The proxy binds loopback only. The reverse tunnel exposes it only on the
 * remote host's loopback interface while the SSH connection is up.
 *
 * @module dsh-remote-local/credentials/proxy
 */

import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Options for one proxy instance. */
export interface CredentialProxyOptions {
  /** Real provider key. Never logged or returned. */
  readonly apiKey: string
  /** Provider origin, for example `https://api.deepseek.com`. */
  readonly upstreamBaseUrl: string
  /** Loopback bind address; defaults to 127.0.0.1. */
  readonly host?: string
  /** Per-request upstream idle timeout. */
  readonly timeoutMs?: number
  /** Whether a caller-supplied placeholder is one of this profile's proxy tokens. */
  readonly isTokenValid: (token: string) => boolean
}

/** Started proxy. */
export interface CredentialProxyAddress {
  readonly port: number
  readonly baseUrl: string
}

/** Loopback credential proxy. */
export class ModelCredentialProxy {
  readonly #apiKey: string
  readonly #upstream: URL
  readonly #host: string
  readonly #timeoutMs: number
  readonly #isTokenValid: (token: string) => boolean
  #server: Server | undefined

  constructor(options: CredentialProxyOptions) {
    if (options.apiKey.trim() === '') throw new TypeError('credential proxy requires a non-empty API key')
    this.#apiKey = options.apiKey
    this.#upstream = new URL(options.upstreamBaseUrl)
    if (this.#upstream.protocol !== 'http:' && this.#upstream.protocol !== 'https:') {
      throw new TypeError(`credential proxy upstream must be HTTP(S), got ${this.#upstream.protocol}`)
    }
    this.#host = options.host ?? '127.0.0.1'
    this.#timeoutMs = options.timeoutMs ?? 300_000
    this.#isTokenValid = options.isTokenValid
  }

  /** Start on an ephemeral loopback port. */
  async start(): Promise<CredentialProxyAddress> {
    if (this.#server !== undefined) throw new Error('credential proxy already started')
    const server = createHttpServer((req, res) => this.#forward(req, res))
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, this.#host, () => resolve())
    })
    const address = server.address() as AddressInfo
    return { port: address.port, baseUrl: `http://${this.#host}:${address.port}` }
  }

  /** Stop and release active sockets. */
  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  #forward(req: IncomingMessage, res: ServerResponse): void {
    const presented = presentedToken(req)
    let authorized = false
    try {
      authorized = presented !== undefined && this.#isTokenValid(presented)
    } catch {
      authorized = false
    }
    if (!authorized) {
      writeError(res, 401, 'credential proxy authorization required')
      return
    }
    let incoming: URL
    try {
      incoming = new URL(req.url ?? '/', 'http://credential-proxy.invalid')
    } catch {
      writeError(res, 400, 'invalid proxy request path')
      return
    }
    // Do not allow a caller to redirect the upstream origin. Join the base
    // path (for example /anthropic) instead of dropping it when the request
    // path starts with '/', which is what `new URL(path, base)` would do.
    const target = new URL(this.#upstream.origin)
    const basePath = this.#upstream.pathname.replace(/\/+$/u, '')
    let incomingPath = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`
    // Tolerate a remote DSH whose base URL already includes the same provider
    // prefix (for example /anthropic) as the proxy upstream.
    if (basePath !== '' && (incomingPath === basePath || incomingPath.startsWith(`${basePath}/`))) {
      incomingPath = incomingPath.slice(basePath.length) || '/'
    }
    target.pathname = `${basePath}${incomingPath}` || '/'
    target.search = incoming.search

    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (name === 'host' || name === 'authorization' || name === 'x-api-key' || name === 'connection') continue
      headers[name] = value
    }
    headers.authorization = `Bearer ${this.#apiKey}`
    headers['x-api-key'] = this.#apiKey

    const request = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = request(target, { method: req.method, headers }, upstreamResponse => {
      res.statusCode = upstreamResponse.statusCode ?? 502
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined) res.setHeader(name, value)
      }
      upstreamResponse.pipe(res)
    })
    upstream.setTimeout(this.#timeoutMs, () => {
      upstream.destroy(new Error('upstream credential proxy request timed out'))
    })
    upstream.on('error', error => {
      if (!res.headersSent) writeError(res, 502, 'model provider request failed')
      else res.destroy(error)
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }
}

function presentedToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer[ \t]+(.+)$/iu.exec(authorization.trim())
    if (match?.[1] !== undefined) return match[1].trim()
  }
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.trim() !== '') return apiKey.trim()
  return undefined
}

function writeError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: { message } }))
}
