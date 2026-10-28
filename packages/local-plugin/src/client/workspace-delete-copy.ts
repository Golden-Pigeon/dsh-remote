/**
 * Correct the native workspace-delete description for mirrored workspaces.
 *
 * DSH's workspace UI owns the delete modal and its copy. Its public locale API
 * rejects replacing an existing namespace, and the modal has no description
 * slot. Mirror sessions are archived instead of moved to Ungrouped, so patch
 * the one affected sentence in the rendered modal while it is open.
 *
 * @module dsh-remote-local/client/workspace-delete-copy
 */

import type { HostsApi } from './api.ts'

export const EN_DELETE_SUFFIX = 'Its sessions will appear under Ungrouped.'
export const ZH_DELETE_SUFFIX = '其会话将显示在“未分组”下。'
export const EN_DELETE_REPLACEMENT = 'Its sessions will be archived locally; re-add the workspace to restore them.'
export const ZH_DELETE_REPLACEMENT = '其会话会在本地归档；重新添加工作区后可恢复。'

/** Replace the Ungrouped sentence when the dialog names a mirrored workspace. */
export function rewriteWorkspaceDeleteCopy(text: string, titles: ReadonlySet<string>): string | undefined {
  const suffix = text.includes(EN_DELETE_SUFFIX)
    ? EN_DELETE_SUFFIX
    : text.includes(ZH_DELETE_SUFFIX) ? ZH_DELETE_SUFFIX : undefined
  if (suffix === undefined) return undefined
  const mirrored = [...titles].some(title => title !== ''
    && (text.includes(`“${title}”`) || text.includes(`"${title}"`)))
  if (!mirrored) return undefined
  return text.replace(
    suffix,
    suffix === EN_DELETE_SUFFIX ? EN_DELETE_REPLACEMENT : ZH_DELETE_REPLACEMENT,
  )
}

/**
 * Observe DSH's workspace-delete modal and correct the mirrored-workspace copy.
 * Returns a disposer suitable for `ctx.effect`.
 */
export function installWorkspaceDeleteCopy(api: Pick<HostsApi, 'state'>): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  let titles = new Set<string>()
  let refresh: Promise<void> | undefined
  let scheduled = false
  let disposed = false
  const attempted = new WeakSet<Element>()

  const refreshTitles = (): Promise<void> => {
    if (refresh !== undefined) return refresh
    refresh = api.state()
      .then(state => {
        titles = new Set(state.mirroredWorkspaces.map(workspace => workspace.title))
      })
      .catch(() => { /* Keep the previous titles; a later focus retries. */ })
      .finally(() => { refresh = undefined })
    return refresh
  }

  const scan = (): void => {
    scheduled = false
    if (disposed) return
    for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      const textNodes: Text[] = []
      const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.nodeValue
        if (text !== null && (text.includes(EN_DELETE_SUFFIX) || text.includes(ZH_DELETE_SUFFIX))) {
          textNodes.push(node as Text)
        }
      }
      if (textNodes.length === 0) continue
      const full = dialog.textContent ?? ''
      if (rewriteWorkspaceDeleteCopy(full, titles) === undefined) {
        if (!attempted.has(dialog)) {
          attempted.add(dialog)
          void refreshTitles().then(() => { if (!disposed) schedule() })
        }
        continue
      }
      for (const node of textNodes) {
        const text = node.nodeValue
        if (text === null) continue
        node.nodeValue = text.includes(EN_DELETE_SUFFIX)
          ? text.replace(EN_DELETE_SUFFIX, EN_DELETE_REPLACEMENT)
          : text.replace(ZH_DELETE_SUFFIX, ZH_DELETE_REPLACEMENT)
      }
    }
  }

  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    window.setTimeout(scan, 0)
  }

  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === 'characterData'
      || record.type === 'childList' && record.addedNodes.length > 0)) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  const onFocus = (): void => { void refreshTitles().then(schedule) }
  window.addEventListener('focus', onFocus)
  void refreshTitles().then(schedule)
  return () => {
    disposed = true
    observer.disconnect()
    window.removeEventListener('focus', onFocus)
  }
}
