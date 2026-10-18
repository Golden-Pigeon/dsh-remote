/**
 * Settings → 远程开发 page.
 *
 * The page is a projection over the host plugin's authenticated RPC channel.
 * It owns only view state (form fields, which host is expanded); every
 * durable fact and every tunnel lives in the host process.
 *
 * @module dsh-remote-local/client/panel
 */

import { useEffect, useMemo, useState } from 'react'
import type { RemoteSessionSummary, RemoteWorkspace } from '@dsh-remote/protocol'
import type { HostView } from '../hosts/types.ts'
import type { RemoteHostsState } from '../host-api/contract.ts'
import type { HostsApi } from './api.ts'
import panelCss from './panel.css'

/** Props injected by the Settings page. */
interface PanelProps {
  readonly api: HostsApi
}

const PHASE_LABEL: Record<HostView['phase'], string> = {
  idle: '未连接',
  discovering: '发现中',
  installing: '安装中',
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '异常',
}

const POLL_MS = 2_500

/** Render the remote-development settings page. */
export function RemoteDevelopmentPanel({ api }: PanelProps) {
  const [state, setState] = useState<RemoteHostsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [expandedHost, setExpandedHost] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Record<string, RemoteWorkspace[] | undefined>>({})
  const [openWorkspace, setOpenWorkspace] = useState<Record<string, boolean>>({})
  const [sessions, setSessions] = useState<Record<string, RemoteSessionSummary[] | undefined>>({})
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [form, setForm] = useState({
    sshTarget: '',
    label: '',
  })

  useInjectedStyle(panelCss)

  const hosts = useMemo(() => state?.hosts ?? [], [state])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await api.state()
        if (!cancelled) {
          setState(next)
          setError(current => current === '无法连接本地远程宿主服务' ? null : current)
        }
      } catch (failure) {
        if (!cancelled) setError(messageOf(failure, '无法连接本地远程宿主服务'))
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    const onFocus = (): void => { void load() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [api])

  useEffect(() => {
    const host = hosts.find(item => item.id === expandedHost)
    if (host?.phase === 'connected' && workspaces[host.id] === undefined) {
      void loadWorkspaces(host.id)
    }
  }, [hosts, expandedHost, workspaces])

  async function refresh(): Promise<void> {
    setState(await api.state())
  }

  async function run(key: string, task: () => Promise<void>): Promise<void> {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await task()
      await refresh()
    } catch (failure) {
      setError(messageOf(failure, '操作失败'))
    } finally {
      setBusy(null)
    }
  }

  async function onAdd(): Promise<void> {
    const sshTarget = form.sshTarget.trim()
    if (sshTarget === '') {
      setError('请填写 SSH 目标，例如 user@host 或 ssh://user@host:22')
      return
    }
    await run('add', async () => {
      await api.validateTarget(sshTarget)
      const host = await api.addHost({
        sshTarget,
        ...form.label.trim() === '' ? {} : { label: form.label.trim() },
        autoConnect: true,
      })
      setForm({ sshTarget: '', label: '' })
      setExpandedHost(host.id)
      setNotice('主机已保存。插件会自动安装并启动远端 agent；安装进度会显示在主机卡片上。')
    })
  }

  async function toggleHost(host: HostView): Promise<void> {
    if (expandedHost === host.id) {
      setExpandedHost(null)
      return
    }
    setExpandedHost(host.id)
    await loadWorkspaces(host.id)
  }

  async function loadWorkspaces(hostId: string): Promise<void> {
    setWorkspaces(current => ({ ...current, [hostId]: undefined }))
    try {
      const result = await api.workspaces(hostId)
      setWorkspaces(current => ({ ...current, [hostId]: [...result.workspaces] }))
    } catch (failure) {
      setWorkspaces(current => ({ ...current, [hostId]: [] }))
      setError(messageOf(failure, '读取远端工作区失败'))
    }
  }

  async function toggleWorkspace(hostId: string, workspaceId: string): Promise<void> {
    const key = `${hostId}:${workspaceId}`
    const next = !(openWorkspace[key] ?? false)
    setOpenWorkspace(current => ({ ...current, [key]: next }))
    if (!next || sessions[key] !== undefined) return
    setSessions(current => ({ ...current, [key]: undefined }))
    try {
      const result = await api.sessions(hostId, workspaceId)
      setSessions(current => ({ ...current, [key]: [...result.sessions] }))
    } catch (failure) {
      setSessions(current => ({ ...current, [key]: [] }))
      setError(messageOf(failure, '读取远端会话失败'))
    }
  }

  async function addWorkspace(host: HostView): Promise<void> {
    const path = workspaceDraft.trim()
    if (path === '') {
      setError('请填写远端目录的绝对路径，例如 /home/user/project')
      return
    }
    setBusy(`workspace:${host.id}`)
    setError(null)
    try {
      await api.createWorkspace(host.id, { path })
      setWorkspaceDraft('')
      await loadWorkspaces(host.id)
      setExpandedHost(host.id)
    } catch (failure) {
      setError(messageOf(failure, '添加远端工作区失败'))
    } finally {
      setBusy(null)
    }
  }



  async function newSession(host: HostView, workspaceId: string): Promise<void> {
    setBusy(`create:${host.id}:${workspaceId}`)
    setError(null)
    try {
      const created = await api.createSession(host.id, { workspaceId })
      const key = `${host.id}:${workspaceId}`
      setOpenWorkspace(current => ({ ...current, [key]: true }))
      if (created.localSessionId !== undefined) {
        api.openSession(created.localSessionId)
        setNotice('远端会话已创建，正在普通会话界面打开…')
        window.setTimeout(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        }, 80)
      } else {
        setNotice('远端会话已创建，正在同步到侧边栏…')
      }
      const result = await api.sessions(host.id, workspaceId)
      setSessions(current => ({ ...current, [key]: [...result.sessions] }))
      const refreshed = await api.workspaces(host.id)
      setWorkspaces(current => ({ ...current, [host.id]: [...refreshed.workspaces] }))
    } catch (failure) {
      setError(messageOf(failure, '创建远端会话失败'))
    } finally {
      setBusy(null)
    }
  }



  async function onRemove(host: HostView): Promise<void> {
    if (!window.confirm(`删除主机「${host.label}」？远端文件与会话不会被删除。`)) return
    await run(`remove:${host.id}`, async () => {
      await api.removeHost(host.id)
      if (expandedHost === host.id) setExpandedHost(null)
    })
  }

  return (
    <div className="dshr-root">
      <header className="dshr-header">
        <div>
          <h2>远程开发</h2>
          <p className="dshr-subtitle">
            只需填写 SSH 目标。插件会自动安装并启动远端 agent，建立隧道。
            连接后远端工作区和会话会同步到左侧，像本地会话一样打开；模型凭据经隧道代理，不写入远端磁盘。
          </p>
        </div>
        <button
          type="button"
          className="dshr-button"
          onClick={() => { void refresh().catch(failure => setError(messageOf(failure, '刷新失败'))) }}
          disabled={busy !== null}
        >
          刷新
        </button>
      </header>

      {error !== null && <p className="dshr-banner dshr-banner-error" role="alert">{error}</p>}
      {notice !== null && <p className="dshr-banner dshr-banner-info" role="status">{notice}</p>}

      <section className="dshr-card">
        <h3>添加主机</h3>
        <form
          className="dshr-form"
          onSubmit={event => {
            event.preventDefault()
            void onAdd()
          }}
        >
          <label className="dshr-field dshr-field-wide">
            <span>SSH 目标</span>
            <input
              value={form.sshTarget}
              onChange={event => setForm(current => ({ ...current, sshTarget: event.target.value }))}
              placeholder="user@host 或 ssh://user@host:22"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="dshr-field">
            <span>显示名称（可选）</span>
            <input
              value={form.label}
              onChange={event => setForm(current => ({ ...current, label: event.target.value }))}
              placeholder="Example GPU"
            />
          </label>
          <div className="dshr-form-actions">
            <button type="submit" className="dshr-button dshr-button-primary" disabled={busy !== null}>
              {busy === 'add' ? '添加中…' : '保存并连接'}
            </button>
            <span className="dshr-hint">需要密钥或 ssh-agent 免交互登录；首次自动安装约 1–3 分钟。</span>
          </div>
        </form>
      </section>

      <section className="dshr-card">
        <div className="dshr-section-title">
          <h3>主机</h3>
          <span className="dshr-hint">{hosts.length} 台</span>
        </div>
        {hosts.length === 0 && <p className="dshr-empty">还没有远程主机。先在上方添加一台。</p>}
        <div className="dshr-hosts">
          {hosts.map(host => (
            <article key={host.id} className="dshr-host">
              <header className="dshr-host-head">
                <div className="dshr-host-title">
                  <strong>{host.label}</strong>
                  <code>{host.sshTarget}</code>
                </div>
                <span className={`dshr-phase dshr-phase-${host.phase}`}>{PHASE_LABEL[host.phase]}</span>
              </header>

              <dl className="dshr-meta">
                <div><dt>远端端口</dt><dd>{host.remoteAgentPort ?? '—'}</dd></div>
                <div><dt>本地隧道</dt><dd>{host.localPort ?? '—'}</dd></div>
                <div><dt>工作区</dt><dd>{host.workspaceCount ?? '—'}</dd></div>
                <div><dt>Agent</dt><dd>{host.hostInfo?.agentVersion ?? '—'}</dd></div>
                <div><dt>Token</dt><dd>{host.hasToken ? '已保存' : '未保存'}</dd></div>
                <div><dt>模型代理</dt><dd>{host.modelProxy ? '本地代理' : host.modelDirect ? '远端直连' : '远端默认'}</dd></div>
              </dl>

              {host.detail !== null && <p className="dshr-detail">{host.detail}</p>}
              {host.error !== null && <p className="dshr-host-error" role="alert">{host.error}</p>}

              <div className="dshr-actions">
                {host.phase === 'connected'
                  ? (
                    <>
                      <button
                        type="button"
                        className="dshr-button"
                        disabled={busy !== null}
                        onClick={() => { void toggleHost(host) }}
                      >
                        {expandedHost === host.id ? '收起工作区' : '工作区'}
                      </button>
                      <button
                        type="button"
                        className="dshr-button"
                        disabled={busy !== null}
                        onClick={() => { void run(`refresh:${host.id}`, async () => { await api.refresh(host.id) }) }}
                      >
                        重新发现
                      </button>
                      <button
                        type="button"
                        className="dshr-button"
                        disabled={busy !== null}
                        onClick={() => { void run(`disconnect:${host.id}`, async () => { await api.disconnect(host.id) }) }}
                      >
                        断开
                      </button>
                    </>
                  )
                  : (
                    <>
                      <button
                        type="button"
                        className="dshr-button dshr-button-primary"
                        disabled={busy !== null || host.phase === 'installing' || host.phase === 'discovering' || host.phase === 'connecting'}
                        onClick={() => { void run(`connect:${host.id}`, async () => { await api.connect(host.id) }) }}
                      >
                        {host.phase === 'installing' ? '正在安装…' : host.phase === 'connecting' ? '正在连接…' : '连接'}
                      </button>
                      <button
                        type="button"
                        className="dshr-button"
                        disabled={busy !== null}
                        onClick={() => { void run(`refresh:${host.id}`, async () => { await api.refresh(host.id) }) }}
                      >
                        重新发现
                      </button>
                    </>
                  )}
                <button
                  type="button"
                  className="dshr-button"
                  disabled={busy !== null || host.phase === 'installing'}
                  onClick={() => { void run(`provision:${host.id}`, async () => { await api.provision(host.id) }) }}
                >
                  重新安装
                </button>
                <button
                  type="button"
                  className="dshr-button dshr-button-danger"
                  disabled={busy !== null}
                  onClick={() => { void onRemove(host) }}
                >
                  删除
                </button>
              </div>

              {expandedHost === host.id && (
                <div className="dshr-workspaces">
                  <div className="dshr-workspace-add">
                    <input
                      value={workspaceDraft}
                      onChange={event => setWorkspaceDraft(event.target.value)}
                      placeholder="远端目录绝对路径，例如 /home/user/project"
                      spellCheck={false}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void addWorkspace(host)
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="dshr-button dshr-button-small"
                      disabled={busy !== null}
                      onClick={() => { void addWorkspace(host) }}
                    >
                      {busy === `workspace:${host.id}` ? '添加中…' : '添加工作区'}
                    </button>
                  </div>
                  {workspaces[host.id] === undefined
                    ? <p className="dshr-empty">正在读取工作区…</p>
                    : workspaces[host.id]?.length === 0
                      ? <p className="dshr-empty">远端还没有注册工作区。可在远端 DSH 里添加目录后刷新。</p>
                      : workspaces[host.id]?.map(workspace => {
                        const workspaceKey = `${host.id}:${workspace.workspaceId}`
                        const open = openWorkspace[workspaceKey] ?? false
                        return (
                          <div key={workspace.workspaceId} className="dshr-workspace">
                            <div className="dshr-workspace-row">
                              <button
                                type="button"
                                className="dshr-workspace-head"
                                aria-expanded={open}
                                onClick={() => { void toggleWorkspace(host.id, workspace.workspaceId) }}
                              >
                                <span className="dshr-caret">{open ? '▾' : '▸'}</span>
                                <span>{workspace.title}</span>
                                <code>{workspace.path}</code>
                                <span className="dshr-count">{workspace.sessionIds.length} 个会话</span>
                              </button>
                              <button
                                type="button"
                                className="dshr-button dshr-button-small"
                                disabled={busy !== null}
                                onClick={() => { void newSession(host, workspace.workspaceId) }}
                              >
                                {busy === `create:${host.id}:${workspace.workspaceId}` ? '创建中…' : '+ 新会话'}
                              </button>
                            </div>
                            {open && (
                              <div className="dshr-sessions">
                                {sessions[workspaceKey] === undefined
                                  ? <p className="dshr-empty">正在读取会话…</p>
                                  : sessions[workspaceKey]?.length === 0
                                    ? <p className="dshr-empty">该工作区暂无会话。点“+ 新会话”开始。</p>
                                    : sessions[workspaceKey]?.map(session => (
                                      <div key={session.sessionId} className="dshr-session">
                                        <span className={session.live ? 'dshr-live' : 'dshr-idle'} />
                                        <code>{session.sessionId}</code>
                                        <span>{session.cwd ?? '—'}</span>
                                        <span className="dshr-count">{session.eventCount ?? '—'} 事件</span>
                                      </div>
                                    ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

    </div>
  )
}

function useInjectedStyle(css: string): void {
  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-remote-local'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [css])
}

function messageOf(value: unknown, fallback: string): string {
  return value instanceof Error && value.message !== '' ? value.message : fallback
}
