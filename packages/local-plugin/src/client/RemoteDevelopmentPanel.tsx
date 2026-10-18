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
import type { CopyKey, Translate } from './locale.ts'
import panelCss from './panel.css'

/** Props injected by the Settings page. */
interface PanelProps {
  readonly api: HostsApi
  readonly t: Translate
}

function phaseLabel(t: Translate, phase: HostView['phase']): string {
  return t(`phase.${phase}` as CopyKey)
}

const DETAIL_KEYS: Record<string, CopyKey> = {
  '正在通过 SSH 发现远端 agent…': 'detail.discovering',
  '正在远端安装 DSH 与 dsh-remote-agent，首次约 1–3 分钟…': 'detail.installing',
  '正在建立 SSH 隧道并校验远端 agent…': 'detail.connecting',
  '正在重新安装远端 agent…': 'detail.reprovisioning',
  'SSH 隧道断开，等待重连…': 'detail.reconnecting',
  '已连接；模型请求经本地凭据代理转发': 'detail.connectedProxy',
  '已连接；模型请求由远端直连 DeepSeek': 'detail.connectedDirect',
  '已连接；远端使用自身凭据或未配置模型 key': 'detail.connectedRemote',
}

function detailLabel(t: Translate, detail: string): string {
  const key = DETAIL_KEYS[detail]
  return key === undefined ? detail : t(key)
}

const POLL_MS = 2_500

/** Render the remote-development settings page. */
export function RemoteDevelopmentPanel({ api, t }: PanelProps) {
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
          setError(current => current === t('settings.unavailable') ? null : current)
        }
      } catch (failure) {
        if (!cancelled) setError(messageOf(failure, t('settings.unavailable')))
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
  }, [api, t])

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
      setError(messageOf(failure, t('settings.operationFailed')))
    } finally {
      setBusy(null)
    }
  }

  async function onAdd(): Promise<void> {
    const sshTarget = form.sshTarget.trim()
    if (sshTarget === '') {
      setError(t('settings.sshRequired'))
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
      setNotice(t('settings.hostSaved'))
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
      setError(messageOf(failure, t('settings.readWorkspacesFailed')))
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
      setError(messageOf(failure, t('settings.readSessionsFailed')))
    }
  }

  async function addWorkspace(host: HostView): Promise<void> {
    const path = workspaceDraft.trim()
    if (path === '') {
      setError(t('settings.pathRequired'))
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
      setError(messageOf(failure, t('settings.addWorkspaceFailed')))
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
        setNotice(t('settings.sessionOpening'))
        window.setTimeout(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        }, 80)
      } else {
        setNotice(t('settings.sessionSyncing'))
      }
      const result = await api.sessions(host.id, workspaceId)
      setSessions(current => ({ ...current, [key]: [...result.sessions] }))
      const refreshed = await api.workspaces(host.id)
      setWorkspaces(current => ({ ...current, [host.id]: [...refreshed.workspaces] }))
    } catch (failure) {
      setError(messageOf(failure, t('settings.createSessionFailed')))
    } finally {
      setBusy(null)
    }
  }



  async function onRemove(host: HostView): Promise<void> {
    if (!window.confirm(`${t('settings.confirmRemovePrefix')}${host.label}${t('settings.confirmRemoveSuffix')}`)) return
    await run(`remove:${host.id}`, async () => {
      await api.removeHost(host.id)
      if (expandedHost === host.id) setExpandedHost(null)
    })
  }

  return (
    <div className="dshr-root">
      <header className="dshr-header">
        <div>
          <h2>{t('settings.title')}</h2>
          <p className="dshr-subtitle">
            {t('settings.subtitle.lead')}
            {' '}
            {t('settings.subtitle.body')}
          </p>
        </div>
        <button
          type="button"
          className="dshr-button"
          onClick={() => { void refresh().catch(failure => setError(messageOf(failure, t('settings.refreshFailed')))) }}
          disabled={busy !== null}
        >
          {t('settings.refresh')}
        </button>
      </header>

      {error !== null && <p className="dshr-banner dshr-banner-error" role="alert">{error}</p>}
      {notice !== null && <p className="dshr-banner dshr-banner-info" role="status">{notice}</p>}

      <section className="dshr-card">
        <h3>{t('settings.addHost')}</h3>
        <form
          className="dshr-form"
          onSubmit={event => {
            event.preventDefault()
            void onAdd()
          }}
        >
          <label className="dshr-field dshr-field-wide">
            <span>{t('settings.sshTarget')}</span>
            <input
              value={form.sshTarget}
              onChange={event => setForm(current => ({ ...current, sshTarget: event.target.value }))}
              placeholder={t('settings.sshPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="dshr-field">
            <span>{t('settings.label')}</span>
            <input
              value={form.label}
              onChange={event => setForm(current => ({ ...current, label: event.target.value }))}
              placeholder={t('settings.labelPlaceholder')}
            />
          </label>
          <div className="dshr-form-actions">
            <button type="submit" className="dshr-button dshr-button-primary" disabled={busy !== null}>
              {busy === 'add' ? t('settings.adding') : t('settings.saveConnect')}
            </button>
            <span className="dshr-hint">{t('settings.sshHint')}</span>
          </div>
        </form>
      </section>

      <section className="dshr-card">
        <div className="dshr-section-title">
          <h3>{t('settings.hosts')}</h3>
          <span className="dshr-hint">{hosts.length} {t('settings.hostsUnit')}</span>
        </div>
        {hosts.length === 0 && <p className="dshr-empty">{t('settings.noHosts')}</p>}
        <div className="dshr-hosts">
          {hosts.map(host => (
            <article key={host.id} className="dshr-host">
              <header className="dshr-host-head">
                <div className="dshr-host-title">
                  <strong>{host.label}</strong>
                  <code>{host.sshTarget}</code>
                </div>
                <span className={`dshr-phase dshr-phase-${host.phase}`}>{phaseLabel(t, host.phase)}</span>
              </header>

              <dl className="dshr-meta">
                <div><dt>{t('settings.remotePort')}</dt><dd>{host.remoteAgentPort ?? '—'}</dd></div>
                <div><dt>{t('settings.localTunnel')}</dt><dd>{host.localPort ?? '—'}</dd></div>
                <div><dt>{t('settings.workspaces')}</dt><dd>{host.workspaceCount ?? '—'}</dd></div>
                <div><dt>Agent</dt><dd>{host.hostInfo?.agentVersion ?? '—'}</dd></div>
                <div><dt>{t('settings.token')}</dt><dd>{host.hasToken ? t('settings.saved') : t('settings.unsaved')}</dd></div>
                <div><dt>{t('settings.modelProxy')}</dt><dd>{host.modelProxy ? t('settings.localProxy') : host.modelDirect ? t('settings.direct') : t('settings.remoteDefault')}</dd></div>
              </dl>

              {host.detail !== null && <p className="dshr-detail">{detailLabel(t, host.detail)}</p>}
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
                        {expandedHost === host.id ? t('settings.collapseWorkspaces') : t('settings.expandWorkspaces')}
                      </button>
                      <button
                        type="button"
                        className="dshr-button"
                        disabled={busy !== null}
                        onClick={() => { void run(`refresh:${host.id}`, async () => { await api.refresh(host.id) }) }}
                      >
                        {t('settings.rediscover')}
                      </button>
                      <button
                        type="button"
                        className="dshr-button"
                        disabled={busy !== null}
                        onClick={() => { void run(`disconnect:${host.id}`, async () => { await api.disconnect(host.id) }) }}
                      >
                        {t('settings.disconnect')}
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
                        {host.phase === 'installing' ? t('settings.installing') : host.phase === 'connecting' ? t('settings.connecting') : t('settings.connect')}
                      </button>
                      <button
                        type="button"
                        className="dshr-button"
                        disabled={busy !== null}
                        onClick={() => { void run(`refresh:${host.id}`, async () => { await api.refresh(host.id) }) }}
                      >
                        {t('settings.rediscover')}
                      </button>
                    </>
                  )}
                <button
                  type="button"
                  className="dshr-button"
                  disabled={busy !== null || host.phase === 'installing'}
                  onClick={() => { void run(`provision:${host.id}`, async () => { await api.provision(host.id) }) }}
                >
                  {t('settings.reprovision')}
                </button>
                <button
                  type="button"
                  className="dshr-button dshr-button-danger"
                  disabled={busy !== null}
                  onClick={() => { void onRemove(host) }}
                >
                  {t('settings.remove')}
                </button>
              </div>

              {expandedHost === host.id && (
                <div className="dshr-workspaces">
                  <div className="dshr-workspace-add">
                    <input
                      value={workspaceDraft}
                      onChange={event => setWorkspaceDraft(event.target.value)}
                      placeholder={t('settings.workspacePathPlaceholder')}
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
                      {busy === `workspace:${host.id}` ? t('settings.addingWorkspace') : t('settings.addWorkspace')}
                    </button>
                  </div>
                  {workspaces[host.id] === undefined
                    ? <p className="dshr-empty">{t('settings.readingWorkspaces')}</p>
                    : workspaces[host.id]?.length === 0
                      ? <p className="dshr-empty">{t('settings.noWorkspaces')}</p>
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
                                <span className="dshr-count">{workspace.sessionIds.length} {t('settings.sessionsUnit')}</span>
                              </button>
                              <button
                                type="button"
                                className="dshr-button dshr-button-small"
                                disabled={busy !== null}
                                onClick={() => { void newSession(host, workspace.workspaceId) }}
                              >
                                {busy === `create:${host.id}:${workspace.workspaceId}` ? t('settings.creating') : t('settings.newSession')}
                              </button>
                            </div>
                            {open && (
                              <div className="dshr-sessions">
                                {sessions[workspaceKey] === undefined
                                  ? <p className="dshr-empty">{t('settings.readingSessions')}</p>
                                  : sessions[workspaceKey]?.length === 0
                                    ? <p className="dshr-empty">{t('settings.noSessions')}</p>
                                    : sessions[workspaceKey]?.map(session => (
                                      <div key={session.sessionId} className="dshr-session">
                                        <span className={session.live ? 'dshr-live' : 'dshr-idle'} />
                                        <code>{session.sessionId}</code>
                                        <span>{session.cwd ?? '—'}</span>
                                        <span className="dshr-count">{session.eventCount ?? '—'} {t('settings.eventsUnit')}</span>
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
