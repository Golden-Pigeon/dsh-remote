/**
 * Remote model rows appended to the composer's model menu.
 *
 * The composer model menu lists this Host's providers, and a mirrored Session
 * runs on this Host, so the native rows can never offer a model that only the
 * remote host serves. This contributes the remote catalog as extra rows instead:
 * the native list stays intact and picking a remote row installs that selection
 * on the mirror, which the existing bridge forwards to the remote.
 *
 * @module dsh-remote-local/client/RemoteModelRows
 */

import { useEffect, useRef, useState } from 'react'
import type { ModelCatalogResult } from '@dsh-remote/protocol'
import type { HostsApi } from './api.ts'
import type { MirrorTarget } from '../host-api/contract.ts'
import type { Translate } from './locale.ts'
import rowsCss from './RemoteModelRows.css'

/** Props the composer model menu injects into an options contribution. */
interface OptionsSlotProps {
  /** The Session whose menu is open. */
  readonly sessionId: string
  /** Whether the menu currently refuses selection changes. */
  readonly locked: boolean
  /** Close the menu and return focus to its trigger. */
  readonly dismiss: () => void
  /** Report a failed selection through the menu's toast. */
  readonly reportFailure: (message: string) => void
}

/** Injected face for this contribution. */
export interface RemoteModelRowsInjected {
  readonly api: HostsApi
  readonly t: Translate
}

/** One flat row: a model the remote host can run. */
interface Row {
  readonly key: string
  readonly label: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Install the contribution's stylesheet once per mount. */
function useInjectedStyle(css: string): void {
  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-remote-local/models'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, [css])
}

/**
 * Render the remote host's models as extra rows in the model menu.
 *
 * Returns null for anything that is not a live mirror: ordinary local Sessions
 * keep the unmodified menu, which is what keeps this additive.
 * @param props - Session scope, menu owner callbacks, and the injected API.
 * @returns the remote rows, or null when this Session has no remote host.
 */
export function RemoteModelRows(
  { sessionId, locked, dismiss, reportFailure, api, t }: OptionsSlotProps & RemoteModelRowsInjected,
) {
  const [target, setTarget] = useState<MirrorTarget | undefined>(undefined)
  const [catalog, setCatalog] = useState<ModelCatalogResult | undefined>(undefined)
  const [pending, setPending] = useState<string | null>(null)
  /** One failure report per mount: reopening the menu must not re-toast. */
  const reported = useRef(false)

  useInjectedStyle(rowsCss)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const mirror = await api.sessionMirror(sessionId)
        if (!active) return
        setTarget(mirror)
        if (mirror === null) return
        const next = await api.modelCatalog(mirror.hostId)
        if (active) setCatalog(next)
      } catch (error) {
        if (!active) return
        // Stay additive: a host that cannot answer must not break the menu, but
        // it must not fail invisibly either — the rows simply not appearing is
        // otherwise indistinguishable from a host with no models configured.
        setTarget(null)
        const detail = error instanceof Error ? error.message : String(error)
        console.warn('dsh-remote-local: could not load the remote model catalog:', detail)
        if (!reported.current) {
          reported.current = true
          reportFailure(`${t('model.loadFailed')}: ${detail}`)
        }
      }
    })()
    return () => { active = false }
  }, [api, sessionId, reportFailure, t])

  const rows = buildRows(catalog)
  if (target === null || target === undefined || rows.length === 0) return null

  const choose = (row: Row): void => {
    if (locked || pending !== null) return
    setPending(row.key)
    void api.setSessionModel({
      localSessionId: sessionId,
      provider: row.provider,
      model: row.model,
      ...row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort },
    }).then(() => {
      dismiss()
    }, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      reportFailure(`${t('model.failed')}: ${detail}`)
    }).finally(() => { setPending(null) })
  }

  return (
    <div className="dshr-model-group">
      <p className="dshr-model-heading">{t('model.groupTitlePrefix')}{target.hostLabel}</p>
      {rows.map(row => (
        <button
          key={row.key}
          type="button"
          className="dshr-model-option"
          disabled={locked || pending !== null}
          onClick={() => { choose(row) }}
        >
          <span className="dshr-model-name">{row.label}</span>
          <code className="dshr-model-id">{row.model}</code>
        </button>
      ))}
    </div>
  )
}

/**
 * Flatten the remote catalog into menu rows.
 *
 * A model's default reasoning effort travels with the row so the selection the
 * remote receives matches what its own selector would send.
 */
function buildRows(catalog: ModelCatalogResult | undefined): Row[] {
  if (catalog === undefined) return []
  const rows: Row[] = []
  for (const group of catalog.groups) {
    for (const model of group.models) {
      rows.push({
        key: `${group.id}/${model.id}`,
        label: model.name,
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      })
    }
  }
  return rows
}
