/**
 * Remote session drawer: snapshot polling plus prompt/cancel.
 *
 * This is the "actually usable" path inside the Settings page. It is not a
 * second agent loop: the remote DSH session owns the run, and the local page
 * only sends prompts and renders the committed event transcript.
 *
 * @module dsh-remote-local/client/RemoteChatPanel
 */

import { useEffect, useRef, useState } from 'react'
import type { RemoteSessionEvent, SessionSnapshot } from '@dsh-remote/protocol'
import type { HostsApi } from './api.ts'

interface RemoteChatPanelProps {
  readonly api: HostsApi
  readonly hostId: string
  readonly hostLabel: string
  readonly sessionId: string
  readonly onClose: () => void
  readonly onOpenRemote: () => void
}

interface ChatLine {
  readonly key: string
  readonly role: 'user' | 'assistant' | 'tool' | 'status'
  readonly text: string
}

/** Render the remote chat drawer. */
export function RemoteChatPanel({
  api,
  hostId,
  hostLabel,
  sessionId,
  onClose,
  onOpenRemote,
}: RemoteChatPanelProps) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'prompt' | 'cancel' | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async (): Promise<void> => {
      try {
        const next = await api.snapshot(hostId, sessionId, 500)
        if (cancelled) return
        setSnapshot(next)
        setError(null)
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : '读取远端会话失败')
      }
      if (!cancelled) timer = window.setTimeout(() => { void load() }, 1_200)
    }
    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [api, hostId, sessionId])

  const lines = snapshot === null ? [] : toLines(snapshot.events)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])

  async function send(): Promise<void> {
    const value = text.trim()
    if (value === '') return
    setBusy('prompt')
    setError(null)
    try {
      await api.prompt(hostId, sessionId, value)
      setText('')
      const next = await api.snapshot(hostId, sessionId, 500)
      setSnapshot(next)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '发送失败')
    } finally {
      setBusy(null)
    }
  }

  async function cancel(): Promise<void> {
    setBusy('cancel')
    setError(null)
    try {
      await api.cancel(hostId, sessionId)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '取消失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="dshr-chat" role="region" aria-label={`远端会话 ${sessionId}`}>
      <header className="dshr-chat-head">
        <div className="dshr-chat-title">
          <strong>{hostLabel}</strong>
          <code>{sessionId}</code>
          <span className={snapshot?.live === true ? 'dshr-live' : 'dshr-idle'} />
          <span className="dshr-hint">{snapshot?.events.length ?? 0} 事件</span>
        </div>
        <div className="dshr-chat-head-actions">
          <button type="button" className="dshr-button" onClick={onOpenRemote}>完整远端界面</button>
          <button type="button" className="dshr-button" onClick={onClose}>关闭</button>
        </div>
      </header>

      {error !== null && <p className="dshr-banner dshr-banner-error" role="alert">{error}</p>}
      {snapshot?.truncated === true && (
        <p className="dshr-banner dshr-banner-info">只显示了最近 500 条事件；完整历史请打开远端界面。</p>
      )}

      <div className="dshr-chat-log" aria-live="polite">
        {snapshot === null && <p className="dshr-empty">正在读取会话…</p>}
        {snapshot !== null && lines.length === 0 && (
          <p className="dshr-empty">还没有消息。输入一条提示词，远端 DSH 会开始工作。</p>
        )}
        {lines.map(line => (
          <div key={line.key} className={`dshr-chat-line dshr-chat-${line.role}`}>
            <span className="dshr-chat-role">{line.role === 'user' ? '你' : line.role === 'assistant' ? '远端' : line.role === 'tool' ? '工具' : '状态'}</span>
            <pre>{line.text}</pre>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="dshr-chat-compose">
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder="给远端会话发消息…（⌘/Ctrl+Enter 发送）"
          rows={3}
          disabled={busy !== null}
        />
        <div className="dshr-chat-actions">
          <button
            type="button"
            className="dshr-button dshr-button-primary"
            disabled={busy !== null || text.trim() === ''}
            onClick={() => { void send() }}
          >
            {busy === 'prompt' ? '发送中…' : '发送'}
          </button>
          <button
            type="button"
            className="dshr-button"
            disabled={busy !== null}
            onClick={() => { void cancel() }}
          >
            停止当前轮次
          </button>
          <span className="dshr-hint">远端 agent 执行；本地只负责发送和展示。</span>
        </div>
      </div>
    </div>
  )
}

function toLines(events: readonly RemoteSessionEvent[]): ChatLine[] {
  const lines: ChatLine[] = []
  for (const event of events) {
    const line = toLine(event)
    if (line !== null) lines.push(line)
  }
  return lines.slice(-300)
}

function toLine(event: RemoteSessionEvent): ChatLine | null {
  if (event.type === 'user/message') {
    const source = (event.data as { source?: { kind?: unknown } }).source
    // Synthetic runtime context, time context, and instructions are model
    // input, not human turns. Keep the transcript focused on the user.
    if (source?.kind !== 'user') return null
    const text = contentText((event.data as { content?: unknown }).content)
    return text === '' ? null : { key: `u-${event.seq}`, role: 'user', text }
  }
  if (event.type === 'assistant/message') {
    const data = event.data as { message?: { content?: unknown } }
    const text = contentText(data.message?.content)
    return text === '' ? null : { key: `a-${event.seq}`, role: 'assistant', text }
  }
  if (event.type === 'tool/result') {
    const data = event.data as { message?: { content?: unknown } }
    const text = contentText(data.message?.content)
    if (text !== '') return { key: `t-${event.seq}`, role: 'tool', text: text.slice(0, 4_000) }
  }
  if (event.type === 'turn/end') {
    const reason = (event.data as { reason?: unknown }).reason
    const label = typeof reason === 'string'
      ? reason
      : typeof reason === 'object' && reason !== null && 'kind' in reason
        ? String((reason as { kind: unknown }).kind)
        : 'done'
    return { key: `s-${event.seq}`, role: 'status', text: `轮次结束：${label}` }
  }
  return null
}

function contentText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const part of value) {
    if (typeof part === 'string') parts.push(part)
    else if (typeof part === 'object' && part !== null) {
      const record = part as { type?: unknown; text?: unknown }
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    }
  }
  return parts.join('\n').trim()
}
