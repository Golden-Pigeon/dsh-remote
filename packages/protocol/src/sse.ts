/**
 * Minimal Server-Sent Events parser.
 *
 * The remote agent uses SSE because it is a first-class browser/Node primitive,
 * survives ordinary proxies, and lets the local plugin consume a session event
 * stream with `fetch` instead of adding a WebSocket dependency. The parser
 * implements the parts of the EventSource wire format this protocol uses:
 * `event:`, `data:`, `id:`, comments, and blank-line dispatch.
 *
 * @module @dsh-remote/protocol/sse
 */

/** One dispatched SSE message. */
export interface SseMessage {
  readonly event: string
  readonly data: string
  readonly id: string | undefined
}

/**
 * Parse an SSE byte stream into messages.
 *
 * The generator ends when the body ends. It does not retry; reconnection is a
 * policy owned by the caller.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let id: string | undefined

  const dispatch = (): SseMessage | undefined => {
    if (dataLines.length === 0 && eventName === '' && id === undefined) return undefined
    const message: SseMessage = {
      event: eventName === '' ? 'message' : eventName,
      data: dataLines.join('\n'),
      id,
    }
    eventName = ''
    dataLines = []
    id = undefined
    return message
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
      } else {
        buffer += decoder.decode(value, { stream: true })
      }

      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        let line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)

        if (line === '') {
          const message = dispatch()
          if (message !== undefined) yield message
        } else if (line.startsWith(':')) {
          // Comment / heartbeat.
        } else {
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          let fieldValue = colon < 0 ? '' : line.slice(colon + 1)
          if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
          switch (field) {
            case 'event':
              eventName = fieldValue
              break
            case 'data':
              dataLines.push(fieldValue)
              break
            case 'id':
              id = fieldValue
              break
            default:
              // Unknown fields are ignored per the EventSource spec.
              break
          }
        }

        newline = buffer.indexOf('\n')
      }

      if (done) {
        if (buffer !== '') {
          const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
          buffer = ''
          if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
          else if (line.startsWith('event:')) eventName = line.slice(6).replace(/^ /, '')
          else if (line.startsWith('id:')) id = line.slice(3).replace(/^ /, '')
        }
        const message = dispatch()
        if (message !== undefined) yield message
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
