/**
 * Authenticated streaming route for mirrored remote terminals.
 *
 * The stock terminal Remote service is bound before an instance adapter can
 * replace it, so the client terminal proxy talks to this exact Fetch route
 * instead. Unary actions return JSON; attach returns SSE frames already in the
 * shape the normal terminal UI consumes.
 *
 * @module dsh-remote-local/host-api/terminal
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { RemoteTerminals } from '../remote/terminal.ts'

export const TERMINAL_API_PATH = '/api/dsh-remote-terminal'

/** Register the terminal route. */
export function registerTerminalApi(ctx: Context, terminals: RemoteTerminals): () => Promise<void> {
  return ctx.connection.fetch.register({
    path: TERMINAL_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      let body: Record<string, unknown>
      try {
        body = await request.json() as Record<string, unknown>
      } catch {
        return Response.json({ ok: false, error: { code: 'request/invalid', message: 'body must be JSON' } })
      }
      try {
        const action = String(body.action ?? '')
        const sessionId = String(body.sessionId ?? '')
        if (action === 'context') return Response.json({ ok: true, mirrored: terminals.isMirrored(sessionId) })
        if (action === 'environment') return Response.json({ ok: true, value: terminals.environment(sessionId) })
        if (action === 'shells') return Response.json({ ok: true, value: terminals.shells() })
        if (action === 'list') return Response.json({ ok: true, value: await terminals.list(sessionId) })
        if (action === 'create') {
          return Response.json({
            ok: true,
            value: await terminals.create(sessionId, {
              ...typeof body.id === 'string' ? { id: body.id } : {},
              ...typeof body.cols === 'number' ? { cols: body.cols } : {},
              ...typeof body.rows === 'number' ? { rows: body.rows } : {},
              ...typeof body.shellPath === 'string' ? { shellPath: body.shellPath } : {},
            }),
          })
        }
        const id = String(body.id ?? '')
        if (action === 'input') {
          await terminals.input(id, { type: 'write', sequence: Number(body.sequence ?? 0), data: String(body.data ?? '') })
          return Response.json({ ok: true, value: null })
        }
        if (action === 'resize') {
          await terminals.input(id, { type: 'resize', sequence: Number(body.sequence ?? 0), cols: Number(body.cols ?? 80), rows: Number(body.rows ?? 24) })
          return Response.json({ ok: true, value: null })
        }
        if (action === 'rename') {
          await terminals.rename(id, String(body.title ?? ''))
          return Response.json({ ok: true, value: null })
        }
        if (action === 'close') {
          await terminals.close(id)
          return Response.json({ ok: true, value: null })
        }
        if (action === 'retain') {
          return new Response(sse([{ type: 'retained' }].map(frame => `event: frame\ndata: ${JSON.stringify(frame)}\n\n`).join('')), {
            headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
          })
        }
        if (action === 'attach') {
          const signal = request.signal
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder()
              try {
                for await (const frame of terminals.attach(id, signal)) {
                  controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`))
                }
              } catch (error) {
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`))
              } finally {
                controller.close()
              }
            },
          })
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            },
          })
        }
        return Response.json({ ok: false, error: { code: 'request/invalid', message: `unknown terminal action ${action}` } })
      } catch (error) {
        return Response.json({ ok: false, error: { code: 'terminal/error', message: error instanceof Error ? error.message : String(error) } })
      }
    },
  })
}

function sse(value: string): string {
  return value
}
