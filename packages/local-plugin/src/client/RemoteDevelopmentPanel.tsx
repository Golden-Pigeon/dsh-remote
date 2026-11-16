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
import type { ModelCatalogResult, RemoteWorkspace } from '@dsh-remote/protocol'
import type { DiscoveredSshHost, HostView, SshDiscoveryResult } from '../hosts/types.ts'
import type { HostDetail } from '../messages.ts'
import type { RemoteHostsState } from '../host-api/contract.ts'
import type { HostsApi } from './api.ts'
import { formatUiText, localizedError } from './errors.ts'
import type { CopyKey, Translate } from './locale.ts'
import { HostActionMenu, type MenuAction } from './HostActionMenu.tsx'
import { pickRemoteDirectory } from './workspace-add.ts'
import panelCss from './panel.css'

/**
 * Last segment of a remote POSIX path, used as a workspace title.
 *
 * Pure string handling rather than `node:path`: the value is a path on the
 * remote host, so the platform module here would pick the wrong separator.
 */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  const name = index === -1 ? trimmed : trimmed.slice(index + 1)
  return name === '' ? trimmed : name
}

/** Props injected by the Settings page. */
interface PanelProps {
  readonly api: HostsApi
  readonly t: Translate
}

/**
 * Row action icons.
 *
 * Drawn as inline SVG rather than characters: glyph fonts render `⏻` and `⏵`
 * at different weights and sizes depending on which fallback the platform
 * picks, so the row icons never lined up. A fixed 14px viewBox with
 * `currentColor` strokes keeps them identical and lets them inherit the
 * button's colour.
 */
function PowerIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4.6 4.9a4.6 4.6 0 1 0 6.8 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Play-in-circle, shown when the host is not connected. */
function PlugIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.6 5.6l4 2.4-4 2.4z" fill="currentColor" />
    </svg>
  )
}

/** Globe, for opening the remote DSH Web UI. */
function GlobeIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M2.4 8h11.2M8 2.4c1.6 1.5 2.4 3.4 2.4 5.6s-.8 4.1-2.4 5.6c-1.6-1.5-2.4-3.4-2.4-5.6S6.4 3.9 8 2.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  )
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
    // Only a connected host has an agent to ask. Loading here otherwise fails
    // with "host is not connected" and shows a banner for something the user
    // just clicked, which reads as an error they caused.
    if (host.phase !== 'connected') return
    // Opening a host is an automatic load, not a requested refresh: share any
    // in-flight request and stay quiet if it fails.
    await Promise.all([loadWorkspaces(host.id, false), loadCatalog(host.id)])
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
        // An automatic load failing is not something the user did. Raising a
        // page-level banner for it reads as an error they caused, and the host
        // row already shows its own state. Only a requested refresh reports.
        if (refresh) setError(localizedError(t, failure, t('settings.readWorkspacesFailed')))
      }
    })()
    loadingWorkspaces.current.set(hostId, request)
    try {
      await request
    } finally {
      loadingWorkspaces.current.delete(hostId)
    }
  }

  /**
   * Pick a workspace folder on the remote host.
   *
   * Uses the sidebar dialog's folder browser, so both entry points behave the
   * same; the chosen path also names the workspace, which the user can override
   * by editing the field afterwards.
   */
  async function browseWorkspace(host: HostView): Promise<void> {
    const start = workspaceDraft.trim() === '' ? '~' : workspaceDraft.trim()
    await pickRemoteDirectory({ api, t, host, initialPath: start }, path => {
      setWorkspaceDraft(path)
    }).catch(failure => {
      setError(localizedError(t, failure, t('settings.addWorkspaceFailed')))
    })
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
      // Name the workspace after the folder unless the agent already has one.
      // A bare path is hard to scan in the list, and the server accepts a title.
      await api.createWorkspace(host.id, { path, title: folderName(path) })
      setWorkspaceDraft('')
      await loadWorkspaces(host.id)
      setExpandedHost(host.id)
    } catch (failure) {
      setError(localizedError(t, failure, t('settings.addWorkspaceFailed')))
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
   * Connecting, opening the Web UI and expanding are one click away on the row
   * itself, so they are not repeated here. What remains is either rarely used
   * or worth a deliberate step.
   */
  function hostActions(host: HostView): readonly MenuAction[] {
    const busyNow = busy !== null
    const actions: MenuAction[] = [
      {
        // Recovery, not routine: only useful when the remote agent moved or its
        // token went stale.
        id: 'refresh',
        label: t('settings.rediscover'),
        disabled: busyNow,
        run: () => { void run(`refresh:${host.id}`, async () => { await api.refresh(host.id) }) },
      },
    ]
    if (host.dshUpdate !== null) {
      actions.push({
        id: 'upgrade',
        label: t('settings.dshUpdateAction'),
        disabled: busyNow || host.phase === 'installing',
        run: () => { void run(`upgrade:${host.id}`, async () => { await api.upgrade(host.id) }) },
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
          <h3>{t('settings.hosts')}</h3>
          <span className="dshr-hint">{hosts.length} {t('settings.hostsUnit')}</span>
        </div>
        {hosts.length === 0 && <p className="dshr-empty">{t('settings.noHosts')}</p>}
        <div className="dshr-hosts">
          {hosts.map(host => {
            const expanded = expandedHost === host.id
            const connected = host.phase === 'connected'
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
                    {(() => {
                      // The dot already says connected or not, so repeating it
                      // in words is noise. A transitional phase is worth
                      // spelling out: the dot cannot show what is happening,
                      // and "installing" explains why the row looks stuck.
                      const transitional = !connected
                        && host.phase !== 'idle'
                        && host.phase !== 'disconnected'
                      const facts = [
                        transitional ? phaseLabel(t, host.phase) : null,
                        host.workspaceCount != null
                          ? `${host.workspaceCount} ${t('settings.workspaces')}`
                          : null,
                        host.hostInfo?.agentVersion != null
                          ? `Agent ${host.hostInfo.agentVersion}`
                          : null,
                        // Only meaningful once the host is connected: an idle
                        // host has no resolved credential path yet.
                        connected || host.modelProxy || host.modelDirect
                          ? host.modelProxy
                            ? t('settings.localProxy')
                            : host.modelDirect ? t('settings.direct') : t('settings.remoteDefault')
                          : null,
                      ].filter((item): item is string => item !== null)
                      if (facts.length === 0) return null
                      return (
                        <div className="dshr-host-sub">
                          {facts.map(fact => <span key={fact}>{fact}</span>)}
                        </div>
                      )
                    })()}
                  </div>
                  <div className="dshr-host-tail">
                    {/* The two actions you reach for most sit on the row itself,
                        so connecting or opening the Web UI never needs the row
                        expanded first. */}
                    <button
                      type="button"
                      className="dshr-icon-btn"
                      aria-label={connected ? t('settings.disconnect') : t('settings.connect')}
                      title={connected ? t('settings.disconnect') : t('settings.connect')}
                      disabled={busy !== null || host.phase === 'installing' || host.phase === 'discovering'}
                      onClick={event => {
                        event.stopPropagation()
                        void run(
                          `${connected ? 'disconnect' : 'connect'}:${host.id}`,
                          async () => {
                            await (connected ? api.disconnect(host.id) : api.connect(host.id))
                          },
                        )
                      }}
                    >
                      {busy === `disconnect:${host.id}` || busy === `connect:${host.id}`
                        ? <span className="dshr-icon-spin" aria-hidden="true">⋯</span>
                        : connected ? <PowerIcon /> : <PlugIcon />}
                    </button>
                    <button
                      type="button"
                      className="dshr-icon-btn"
                      aria-label={t('settings.openWebUi')}
                      title={t('settings.openWebUi')}
                      disabled={busy !== null || !connected}
                      onClick={event => {
                        event.stopPropagation()
                        void openWebUi(host)
                      }}
                    >
                      {busy === `web:${host.id}` ? <span className="dshr-icon-spin" aria-hidden="true">⋯</span> : <GlobeIcon />}
                    </button>
                    <HostActionMenu
                      label={`${t('settings.hostActions')}: ${host.label}`}
                      actions={hostActions(host)}
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
                            onClick={() => { void browseWorkspace(host) }}
                          >
                            {t('settings.browseWorkspace')}
                          </button>
                          <button
                            type="button"
                            className="dshr-button dshr-button-small dshr-button-primary"
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
                            : (
                              <ul className="dshr-workspace-list">
                                {workspaces[host.id]?.map(workspace => (
                                  <li key={workspace.workspaceId} className="dshr-workspace-item">
                                    <code>{workspace.path}</code>
                                    <span className="dshr-count">
                                      {workspace.sessionIds.length} {t('settings.sessionsUnit')}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                      </div>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </section>

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
