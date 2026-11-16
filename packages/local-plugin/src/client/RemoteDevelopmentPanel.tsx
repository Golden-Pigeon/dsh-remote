/**
 * Settings → 远程开发 page.
 *
 * The page is a projection over the host plugin's authenticated RPC channel.
 * It owns only view state (form fields, which host is expanded); every
 * durable fact and every tunnel lives in the host process.
 *
 * @module dsh-remote-local/client/panel
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelCatalogResult, RemoteSessionSummary, RemoteWorkspace } from '@dsh-remote/protocol'
import type { DiscoveredSshHost, HostView, SshDiscoveryResult } from '../hosts/types.ts'
import type { HostDetail } from '../messages.ts'
import type { RemoteHostsState } from '../host-api/contract.ts'
import type { HostsApi } from './api.ts'
import { formatUiText, localizedError } from './errors.ts'
import type { CopyKey, Translate } from './locale.ts'
import { HostActionMenu, type MenuAction } from './HostActionMenu.tsx'
import panelCss from './panel.css'

/** Props injected by the Settings page. */
interface PanelProps {
  readonly api: HostsApi
  readonly t: Translate
}

function phaseLabel(t: Translate, phase: HostView['phase']): string {
  return t(`phase.${phase}` as CopyKey)
}

function detailLabel(t: Translate, detail: HostDetail): string {
  return t(`detail.${detail}` as CopyKey)
}

const POLL_MS = 2_500

/** Render the remote-development settings page. */
export function RemoteDevelopmentPanel({ api, t }: PanelProps) {
  const [state, setState] = useState<RemoteHostsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [expandedHost, setExpandedHost] = useState<string | null>(null)
  /** Host awaiting an inline delete confirmation, or null. */
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Record<string, RemoteWorkspace[] | undefined>>({})
  const loadingWorkspaces = useRef(new Map<string, Promise<void>>())
  const loadingCatalogs = useRef(new Map<string, Promise<void>>())
  const [openWorkspace, setOpenWorkspace] = useState<Record<string, boolean>>({})
  const [sessions, setSessions] = useState<Record<string, RemoteSessionSummary[] | undefined>>({})
  const [catalogs, setCatalogs] = useState<Record<string, ModelCatalogResult | undefined>>({})
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [discovery, setDiscovery] = useState<SshDiscoveryResult | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const scanning = useRef(false)

  useInjectedStyle(panelCss)

  const hosts = useMemo(() => state?.hosts ?? [], [state])

  useEffect(() => {
    if (!hosts.some(host => host.retry !== null)) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hosts])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await api.state()
        if (!cancelled) {
          setState(next)
          setPollError(null)
        }
      } catch (failure) {
        if (!cancelled) setPollError(localizedError(t, failure, t('settings.unavailable')))
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
      void loadWorkspaces(host.id, false)
    }
  }, [hosts, expandedHost, workspaces])

  useEffect(() => {
    void scan(false)
  }, [api])

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
      setError(localizedError(t, failure, t('settings.operationFailed')))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Open the remote DSH Web UI in a browser tab.
   *
   * The URL points at the SSH tunnel's local port and already carries the
   * browser token, so the tab lands signed in on the remote host.
   */
  /**
   * Open the remote DSH Web UI in a browser tab.
   *
   * The URL points at the SSH tunnel's local port and already carries the
   * browser token, so the tab lands signed in on the remote host.
   *
   * `window.open` returns null when the `noopener` feature is requested (the
   * handle is intentionally severed), so a null return says nothing about
   * whether the tab opened. Only a thrown error means opening failed.
   */
  async function openWebUi(host: HostView): Promise<void> {
    const key = `web:${host.id}`
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      const { url } = await api.webUrl(host.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (failure) {
      setError(localizedError(t, failure, t('settings.openWebUiFailed')))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Load the hosts this machine's SSH config already knows.
   *
   * `refresh` bypasses the host-side cache, which is what the rescan action
   * needs after the user edited `~/.ssh/config`.
   */
  async function scan(refresh: boolean): Promise<void> {
    if (scanning.current) return
    scanning.current = true
    if (refresh) setBusy('discover')
    setDiscoveryError(null)
    try {
      setDiscovery(await api.discover(refresh))
    } catch (failure) {
      setDiscoveryError(localizedError(t, failure, t('settings.discovered.failed')))
    } finally {
      scanning.current = false
      if (refresh) setBusy(null)
    }
  }

  /** Register one discovered alias and let the ordinary connect path take over. */
  async function connectDiscovered(entry: DiscoveredSshHost): Promise<void> {
    await run(`discover:${entry.alias}`, async () => {
      const host = await api.addHost({ sshTarget: entry.alias, autoConnect: true })
      setExpandedHost(host.id)
      setNotice(t('settings.hostSaved'))
      await scan(true)
    })
  }

  /**
   * Switch this host between the local credential proxy and a remote-direct key.
   *
   * The remote restarts with a new environment, so this is a long operation and
   * the busy label explains why the card looks stuck.
   */
  async function switchModelSource(host: HostView, source: 'proxy' | 'direct'): Promise<void> {
    await run(`source:${host.id}`, async () => {
      await api.setModelSource(host.id, source)
    })
  }

  async function toggleHost(host: HostView): Promise<void> {
    if (expandedHost === host.id) {
      setExpandedHost(null)
      return
    }
    setExpandedHost(host.id)
    await Promise.all([loadWorkspaces(host.id), loadCatalog(host.id)])
  }

  /**
   * Load the model catalog a connected host can route to.
   *
   * A mirror Session runs on this machine, so its model selector only lists the
   * local providers; showing the remote list tells you which selections the
   * remote will actually accept.
   */
  async function loadCatalog(hostId: string): Promise<void> {
    if (catalogs[hostId] !== undefined) return
    const gate = loadingCatalogs.current.get(hostId)
    if (gate !== undefined) return gate
    const task = (async () => {
      try {
        const catalog = await api.modelCatalog(hostId)
        setCatalogs(previous => ({ ...previous, [hostId]: catalog }))
      } catch {
        // A host without the catalog route stays silent rather than showing a
        // permanent error on the Settings page.
        setCatalogs(previous => ({ ...previous, [hostId]: undefined }))
      } finally {
        loadingCatalogs.current.delete(hostId)
      }
    })()
    loadingCatalogs.current.set(hostId, task)
    await task
  }

  async function loadWorkspaces(hostId: string, refresh = true): Promise<void> {
    // Automatic loads share pending work; explicit refreshes need a later snapshot.
    let pending: Promise<void> | undefined
    while ((pending = loadingWorkspaces.current.get(hostId)) !== undefined) {
      await pending
      if (!refresh) return
    }
    const request = (async () => {
      try {
        const result = await api.workspaces(hostId)
        setWorkspaces(current => ({ ...current, [hostId]: [...result.workspaces] }))
      } catch (failure) {
        setWorkspaces(current => ({ ...current, [hostId]: [] }))
        setError(localizedError(t, failure, t('settings.readWorkspacesFailed')))
      }
    })()
    loadingWorkspaces.current.set(hostId, request)
    try {
      await request
    } finally {
      loadingWorkspaces.current.delete(hostId)
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
      setError(localizedError(t, failure, t('settings.readSessionsFailed')))
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
      setError(localizedError(t, failure, t('settings.addWorkspaceFailed')))
    } finally {
      setBusy(null)
    }
  }



  async function newSession(host: HostView, workspaceId: string): Promise<void> {
    setBusy(`create:${host.id}:${workspaceId}`)
    setError(null)
    try {
      const created = await api.startBlankSession(host.id, { workspaceId })
      const key = `${host.id}:${workspaceId}`
      setOpenWorkspace(current => ({ ...current, [key]: true }))
      api.openSession(created.localSessionId)
      setNotice(t('settings.sessionOpening'))
      window.setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }, 80)
      const result = await api.sessions(host.id, workspaceId)
      setSessions(current => ({ ...current, [key]: [...result.sessions] }))
      const refreshed = await api.workspaces(host.id)
      setWorkspaces(current => ({ ...current, [host.id]: [...refreshed.workspaces] }))
    } catch (failure) {
      setError(localizedError(t, failure, t('settings.createSessionFailed')))
    } finally {
      setBusy(null)
    }
  }



  /**
   * Ask for confirmation in the card instead of a native dialog.
   *
   * `window.confirm` ignores the active theme and blocks the whole window, so
   * it reads as a foreign element next to the panel.
   */
  function askRemove(host: HostView): void {
    setPendingRemove(host.id)
    setExpandedHost(host.id)
  }

  async function onRemove(host: HostView): Promise<void> {
    setPendingRemove(null)
    await run(`remove:${host.id}`, async () => {
      await api.removeHost(host.id)
      if (expandedHost === host.id) setExpandedHost(null)
    })
  }

  /**
   * The overflow actions for one host.
   *
   * The four frequent operations stay as buttons in the detail region; these
   * are the destructive and rare ones, kept behind the menu so they are not
   * one stray click away.
   */
  function hostActions(host: HostView, expanded: boolean): readonly MenuAction[] {
    const busyNow = busy !== null
    const actions: MenuAction[] = [
      {
        id: 'expand',
        label: expanded ? t('settings.collapseWorkspaces') : t('settings.expandWorkspaces'),
        run: () => { setExpandedHost(expanded ? null : host.id) },
      },
    ]
    if (host.phase === 'connected') {
      actions.push({
        id: 'web',
        label: t('settings.openWebUi'),
        disabled: busyNow,
        run: () => { void openWebUi(host) },
      })
    }
    actions.push(
      {
        id: 'restart',
        label: t('settings.restart'),
        separated: true,
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`restart:${host.id}`, async () => { await api.restart(host.id) }) },
      },
      {
        id: 'provision',
        label: t('settings.reprovision'),
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`provision:${host.id}`, async () => { await api.provision(host.id) }) },
      },
      {
        id: 'remove',
        label: t('settings.remove'),
        danger: true,
        separated: true,
        disabled: busyNow,
        run: () => { askRemove(host) },
      },
    )
    return actions
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
      </header>

      {error !== null && <p className="dshr-banner dshr-banner-error" role="alert">{error}</p>}
      {pollError !== null && <p className="dshr-banner dshr-banner-error" role="alert">{pollError}</p>}
      {notice !== null && <p className="dshr-banner dshr-banner-info" role="status">{notice}</p>}

      <section className="dshr-card">
        <div className="dshr-section-title">
          <h3>{t('settings.discovered.title')}</h3>
          <button
            type="button"
            className="dshr-button dshr-button-small"
            disabled={busy !== null}
            onClick={() => { void scan(true) }}
          >
            {busy === 'discover' ? t('settings.discovered.scanning') : t('settings.discovered.rescan')}
          </button>
        </div>
        <p className="dshr-hint">{t('settings.discovered.hint')}</p>
        {discoveryError !== null && <p className="dshr-banner dshr-banner-error" role="alert">{discoveryError}</p>}
        {discovery?.error != null && <p className="dshr-banner dshr-banner-error" role="alert">{discovery.error}</p>}
        {discovery === null
          ? <p className="dshr-empty">{t('settings.discovered.scanning')}</p>
          : discovery.hosts.length === 0
            ? <p className="dshr-empty">{t('settings.discovered.empty')}</p>
            : (
              <ul className="dshr-discovered">
                {discovery.hosts.map(entry => (
                  <li key={entry.canonical} className="dshr-discovered-row">
                    <div className="dshr-discovered-main">
                      <strong>{entry.alias}</strong>
                      {entry.aliases.map(name => (
                        <span key={name} className="dshr-alias-tag">{name}</span>
                      ))}
                      <code className="dshr-discovered-endpoint">
                        {entry.user === null ? '' : `${entry.user}@`}
                        {entry.hostname}
                        {entry.port === null ? '' : `:${entry.port}`}
                      </code>
                      {entry.proxyJump && <span className="dshr-badge">{t('settings.discovered.proxy')}</span>}
                    </div>
                    {entry.registeredHostId !== null
                      ? <span className="dshr-hint">{t('settings.discovered.added')}</span>
                      : (
                        <button
                          type="button"
                          className="dshr-button dshr-button-small dshr-button-primary"
                          disabled={busy !== null}
                          onClick={() => { void connectDiscovered(entry) }}
                        >
                          {busy === `discover:${entry.alias}`
                            ? t('settings.discovered.connecting')
                            : t('settings.discovered.connect')}
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            )}
        {discovery !== null && discovery.hosts.length === 0 && discovery.error === null && (
          <p className="dshr-hint">{t('settings.discovered.emptyHint')}</p>
        )}
      </section>

      <section className="dshr-card">
        <div className="dshr-section-title">
          <h3>{t('settings.hosts')}</h3>
          <span className="dshr-hint">{hosts.length} {t('settings.hostsUnit')}</span>
        </div>
        {hosts.length === 0 && <p className="dshr-empty">{t('settings.noHosts')}</p>}
        <div className="dshr-hosts">
          {hosts.map(host => {
            const expanded = expandedHost === host.id
            return (
              <article key={host.id} className={expanded ? 'dshr-host dshr-host-open' : 'dshr-host'}>
                {/* One summary row per machine: status, name, endpoint, menu.
                    Details live behind the row so the list stays scannable. */}
                <div
                  className="dshr-host-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => { void toggleHost(host) }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    void toggleHost(host)
                  }}
                >
                  <span className={`dshr-dot dshr-dot-${host.phase}`} aria-hidden="true" />
                  <div className="dshr-host-main">
                    <div className="dshr-host-title">
                      <strong>{host.label}</strong>
                      {/* The label often defaults to the SSH destination, so
                          repeating it right beside itself adds nothing. */}
                      {host.sshTarget !== host.label && (
                        <code className="dshr-endpoint">{host.sshTarget}</code>
                      )}
                    </div>
                    <div className="dshr-host-sub">
                      <span>{phaseLabel(t, host.phase)}</span>
                      {host.workspaceCount != null && (
                        <span>{host.workspaceCount} {t('settings.workspaces')}</span>
                      )}
                      {host.hostInfo?.agentVersion != null && (
                        <span>Agent {host.hostInfo.agentVersion}</span>
                      )}
                      <span>
                        {host.modelProxy
                          ? t('settings.localProxy')
                          : host.modelDirect ? t('settings.direct') : t('settings.remoteDefault')}
                      </span>
                    </div>
                  </div>
                  <div className="dshr-host-tail">
                    <span className="dshr-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    <HostActionMenu
                      label={`${t('settings.hostActions')}: ${host.label}`}
                      actions={hostActions(host, expanded)}
                    />
                  </div>
                </div>

                {expanded && (
                  <div className="dshr-host-detail">
                    <div className="dshr-field">
                      <span className="dshr-field-label">{t('settings.modelSource')}</span>
                      <span className="dshr-field-value">
                        <span className="dshr-segmented" role="group" aria-label={t('settings.modelSource')}>
                          <button
                            type="button"
                            className={host.modelSource === 'proxy' ? 'dshr-seg dshr-seg-active' : 'dshr-seg'}
                            aria-pressed={host.modelSource === 'proxy'}
                            disabled={busy !== null || host.phase === 'installing' || host.phase === 'discovering'}
                            onClick={() => { void switchModelSource(host, 'proxy') }}
                          >
                            {t('settings.modelSourceProxy')}
                          </button>
                          <button
                            type="button"
                            className={host.modelSource === 'direct' ? 'dshr-seg dshr-seg-active' : 'dshr-seg'}
                            aria-pressed={host.modelSource === 'direct'}
                            disabled={busy !== null || host.phase === 'installing' || host.phase === 'discovering'}
                            onClick={() => { void switchModelSource(host, 'direct') }}
                          >
                            {t('settings.modelSourceDirect')}
                          </button>
                        </span>
                        <span
                          className="dshr-help"
                          title={t('settings.modelSourceHelp')}
                          aria-label={t('settings.modelSourceHelp')}
                        >
                          ?
                        </span>
                        {busy === `source:${host.id}` && (
                          <span className="dshr-detail" role="status">{t('settings.modelSourceBusy')}</span>
                        )}
                      </span>
                    </div>

                    <div className="dshr-field">
                      <span className="dshr-field-label">{t('settings.localTunnel')}</span>
                      <span className="dshr-field-value">
                        <code className="dshr-endpoint">{host.localPort ?? '—'} → {host.remoteAgentPort ?? '—'}</code>
                        <span className="dshr-badge">
                          {host.hasToken ? t('settings.saved') : t('settings.unsaved')}
                        </span>
                        {host.hostInfo?.dshVersion != null && (
                          <span className="dshr-detail">DSH {host.hostInfo.dshVersion}</span>
                        )}
                      </span>
                    </div>

                    {host.dshUpdate !== null && (
                      <div className="dshr-field">
                        <span className="dshr-field-label">{t('settings.dshVersion')}</span>
                        <span className="dshr-field-value">
                          <span className="dshr-warn">
                            {t('settings.dshUpdateHint')}{' '}
                            <code>{host.dshUpdate.remoteVersion}</code> → <code>{host.dshUpdate.localVersion}</code>
                          </span>
                          <button
                            type="button"
                            className="dshr-button dshr-button-small dshr-button-primary"
                            disabled={busy !== null || host.phase === 'installing'}
                            onClick={() => { void run(`upgrade:${host.id}`, async () => { await api.upgrade(host.id) }) }}
                          >
                            {busy === `upgrade:${host.id}` ? t('settings.dshUpdating') : t('settings.dshUpdateAction')}
                          </button>
                        </span>
                      </div>
                    )}

                    {host.retry !== null
                      ? (
                        <p className="dshr-detail">
                          {t('settings.retryPrefix')}{host.retry.attempt}{t('settings.retryMiddle')}
                          {' '}
                          {Math.max(0, Math.ceil((host.retry.at - now) / 1000))}{t('settings.retrySuffix')}
                        </p>
                      )
                      : host.detail !== null && (
                        <p className="dshr-detail">{detailLabel(t, host.detail)}</p>
                      )}
                    {host.agentOutdated && <p className="dshr-detail dshr-agent-outdated">{t('settings.agentOutdated')}</p>}
                    {host.error !== null && (
                      <p className="dshr-host-error" role="alert">
                        {host.errorUi === null ? t('error.unknown') : formatUiText(t, host.errorUi)}
                      </p>
                    )}

                    {catalogs[host.id] !== undefined && (
                      <div className="dshr-models">
                        <p className="dshr-hint">{t('settings.remoteModelsHint')}</p>
                        {catalogs[host.id]!.groups.length === 0
                          ? <p className="dshr-empty">{t('settings.remoteModelsEmpty')}</p>
                          : (
                            <ul className="dshr-model-list">
                              {catalogs[host.id]!.groups.map(group => (
                                <li key={group.id}>
                                  <strong>{group.name}</strong>
                                  <code>{group.id}</code>
                                  <span>{group.models.map(model => model.id).join(', ')}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        {catalogs[host.id]!.failures.map(failure => (
                          <p key={failure.id} className="dshr-detail" role="status">
                            {failure.name}: {failure.message}
                          </p>
                        ))}
                      </div>
                    )}

                    {/* Four frequent actions stay inline; the rest live in the
                        menu so the card never becomes a wall of buttons. */}
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
                              {t('settings.workspaces')}
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
                              onClick={() => { void openWebUi(host) }}
                            >
                              {busy === `web:${host.id}` ? t('settings.openWebUiPending') : t('settings.openWebUi')}
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
                    </div>

                    {pendingRemove === host.id && (
                      <div className="dshr-confirm" role="alertdialog" aria-label={t('settings.remove')}>
                        <span>
                          {t('settings.confirmRemovePrefix')}{host.label}{t('settings.confirmRemoveSuffix')}
                        </span>
                        <button
                          type="button"
                          className="dshr-button dshr-button-small dshr-button-danger"
                          disabled={busy !== null}
                          onClick={() => { void onRemove(host) }}
                        >
                          {t('settings.remove')}
                        </button>
                        <button
                          type="button"
                          className="dshr-button dshr-button-small"
                          onClick={() => { setPendingRemove(null) }}
                        >
                          {t('settings.cancel')}
                        </button>
                      </div>
                    )}

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
                  </div>
                )}
              </article>
            )
          })}
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
