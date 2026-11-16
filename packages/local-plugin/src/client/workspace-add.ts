/**
 * Codex-style unified workspace creation dialog for the sidebar + button.
 *
 * One modal owns the destination (local or a connected remote host), the
 * optional workspace name, and the source folder browser. It is intentionally
 * not a separate local/remote menu.
 *
 * @module dsh-remote-local/client/workspace-add
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostView } from '../hosts/types.ts'
import type { HostsApi } from './api.ts'
import type { Translate } from './locale.ts'
import { localizedError } from './errors.ts'

const ADD_LABELS = new Set(['Add workspace', '添加工作区'])
const NATIVE_CLICK_FLAG = 'dshrNativeClick'
const DIALOG_CLASS = 'dshr-workspace-add-dialog'
let closeDialog: (() => void) | undefined
let closeBrowser: (() => void) | undefined
let closeMenu: (() => void) | undefined

interface WorkspaceFlowContext {
  readonly ctx: Context
  readonly api: HostsApi
  readonly t: Translate
}

type Destination = { readonly kind: 'local' } | { readonly kind: 'remote'; readonly host: HostView }

interface HostDirectoryPicker {
  pick(): Promise<
    | { readonly ok: true; readonly value: string | null }
    | { readonly ok: false; readonly error: { readonly message: string } }
  >
}

interface DesktopDirectoryPicker {
  pick(): Promise<string | null>
}

async function pickLocalDirectory(ctx: Context): Promise<string | null> {
  // DSH Desktop installs this bridge before the client mounts; the stock
  // native directory-flow plugin uses exactly the same entry point.
  const desktop = (globalThis as unknown as { __DSH_DIRECTORY_PICKER__?: DesktopDirectoryPicker }).__DSH_DIRECTORY_PICKER__
  if (desktop !== undefined) return desktop.pick()
  const uiWorkspace = (ctx as unknown as { uiWorkspace?: { pickDirectory?: () => Promise<string | null> } }).uiWorkspace
  if (uiWorkspace?.pickDirectory !== undefined) return uiWorkspace.pickDirectory()
  const remote = (ctx as unknown as { remote?: { directoryPicker?: HostDirectoryPicker } }).remote
  if (remote?.directoryPicker === undefined) throw new Error('directory picker is unavailable')
  const result = await remote.directoryPicker.pick()
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

interface DirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly { readonly name: string; readonly path: string }[]
  readonly truncated: boolean
}

/** Install the sidebar add-workspace dialog once per client mount. */
export function installWorkspaceAddMenu(ctx: Context, api: HostsApi, t: Translate): void {
  if (typeof document === 'undefined') return
  ensureStyles()

  ctx.effect(() => {
    const onClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest<HTMLButtonElement>('button[aria-label]')
      if (button === null) return
      const label = button.getAttribute('aria-label') ?? ''
      if (!ADD_LABELS.has(label)) return
      if (button.closest('[class*="headerActions"]') === null) return
      if (button.dataset[NATIVE_CLICK_FLAG] === '1') {
        delete button.dataset[NATIVE_CLICK_FLAG]
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      void openCreateDialog({ ctx, api, t }, button)
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      closeTransient()
    }
  }, 'dsh-remote: workspace add dialog')
}

async function openCreateDialog(flow: WorkspaceFlowContext, anchor: HTMLButtonElement): Promise<void> {
  closeTransient()
  const overlay = document.createElement('div')
  overlay.className = `${DIALOG_CLASS}-overlay`
  overlay.setAttribute('role', 'presentation')
  const dialog = document.createElement('div')
  dialog.className = DIALOG_CLASS
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', flow.t('dialog.title'))

  const title = document.createElement('h2')
  title.className = `${DIALOG_CLASS}-title`
  title.textContent = flow.t('dialog.title')
  const header = document.createElement('div')
  header.className = `${DIALOG_CLASS}-header`
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.className = `${DIALOG_CLASS}-close`
  closeButton.setAttribute('aria-label', flow.t('dialog.close'))
  closeButton.textContent = '×'
  header.append(title, closeButton)

  // Label + control pairs share one grid so every row lines up.
  const form = document.createElement('div')
  form.className = `${DIALOG_CLASS}-form`

  const nameId = `${DIALOG_CLASS}-name`
  const nameLabel = document.createElement('label')
  nameLabel.className = `${DIALOG_CLASS}-label`
  nameLabel.htmlFor = nameId
  nameLabel.textContent = flow.t('dialog.name')
  const nameInput = document.createElement('input')
  nameInput.id = nameId
  nameInput.className = `${DIALOG_CLASS}-control`
  nameInput.placeholder = flow.t('dialog.namePlaceholder')
  nameInput.autocomplete = 'off'

  const locationId = `${DIALOG_CLASS}-location`
  const locationLabel = document.createElement('label')
  locationLabel.className = `${DIALOG_CLASS}-label`
  locationLabel.htmlFor = locationId
  locationLabel.textContent = flow.t('dialog.location')
  // A button styled as a control, opening an anchored list of destinations.
  const locationButton = document.createElement('button')
  locationButton.type = 'button'
  locationButton.id = locationId
  locationButton.className = `${DIALOG_CLASS}-control ${DIALOG_CLASS}-select`
  locationButton.setAttribute('aria-haspopup', 'listbox')
  const locationIcon = document.createElement('span')
  locationIcon.className = `${DIALOG_CLASS}-control-icon`
  setComputerIcon(locationIcon)
  const locationText = document.createElement('span')
  locationText.className = `${DIALOG_CLASS}-control-text`
  const locationChevron = document.createElement('span')
  locationChevron.className = `${DIALOG_CLASS}-chevron`
  locationChevron.textContent = '⌄'
  locationButton.append(locationIcon, locationText, locationChevron)

  const pathId = `${DIALOG_CLASS}-path`
  const pathLabel = document.createElement('label')
  pathLabel.className = `${DIALOG_CLASS}-label`
  pathLabel.htmlFor = pathId
  pathLabel.textContent = flow.t('dialog.folderTitle')
  const pathRow = document.createElement('div')
  pathRow.className = `${DIALOG_CLASS}-control-row`
  const pathInput = document.createElement('input')
  pathInput.id = pathId
  pathInput.className = `${DIALOG_CLASS}-control`
  pathInput.placeholder = flow.t('dialog.pathPlaceholder')
  pathInput.autocomplete = 'off'
  pathInput.spellcheck = false
  const browse = document.createElement('button')
  browse.type = 'button'
  browse.className = `${DIALOG_CLASS}-browse`
  browse.textContent = flow.t('dialog.browse')
  pathRow.append(pathInput, browse)

  const error = document.createElement('p')
  error.className = `${DIALOG_CLASS}-error`
  error.setAttribute('role', 'alert')

  form.append(nameLabel, nameInput, locationLabel, locationButton, pathLabel, pathRow, error)

  const actions = document.createElement('div')
  actions.className = `${DIALOG_CLASS}-actions`
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = `${DIALOG_CLASS}-button`
  cancel.textContent = flow.t('dialog.cancel')
  const create = document.createElement('button')
  create.type = 'button'
  create.className = `${DIALOG_CLASS}-button ${DIALOG_CLASS}-primary`
  create.textContent = flow.t('dialog.create')
  actions.append(cancel, create)

  dialog.append(header, form, actions)
  overlay.append(dialog)
  document.body.append(overlay)

  let hosts: HostView[] = []
  let destination: Destination = { kind: 'local' }
  const update = (): void => {
    const label = destination.kind === 'local' ? flow.t('dialog.local') : destination.host.label
    locationText.textContent = label
    // The path field is the single source of truth; browsing only fills it in.
    create.disabled = pathInput.value.trim() === ''
  }
  const close = (): void => {
    closeBrowser?.()
    closeMenu?.()
    overlay.remove()
    window.removeEventListener('keydown', keyHandler, true)
    overlay.removeEventListener('pointerdown', outside, true)
    if (closeDialog === close) closeDialog = undefined
  }
  closeDialog = close
  const keyHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  const outside = (event: Event): void => {
    if (event.target === overlay) close()
  }
  window.addEventListener('keydown', keyHandler, true)
  overlay.addEventListener('pointerdown', outside, true)
  cancel.addEventListener('click', close)
  closeButton.addEventListener('click', close)

  locationButton.addEventListener('click', () => {
    openDestinationMenu(locationButton, hosts, destination, flow.t, next => {
      destination = next
      // A path from one host means nothing on another.
      pathInput.value = ''
      update()
    })
  })
  pathInput.addEventListener('input', update)
  pathInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (!create.disabled) create.click()
  })
  browse.addEventListener('click', () => {
    if (destination.kind === 'local') {
      browse.disabled = true
      void pickLocalDirectory(flow.ctx)
        .then(path => {
          if (path !== null) {
            pathInput.value = path
            update()
          }
        })
        .catch(failure => { error.textContent = localizedError(flow.t, failure, flow.t('dialog.nativePickerFailed')) })
        .finally(() => { browse.disabled = false })
      return
    }
    openDirectoryBrowser(flow, destination, pathInput.value.trim() || '~', path => {
      pathInput.value = path
      update()
    })
  })

  try {
    const state = await flow.api.state()
    hosts = state.hosts.filter(host => host.phase === 'connected')
  } catch {
    hosts = []
  }
  update()
  create.addEventListener('click', () => {
    const selectedPath = pathInput.value.trim()
    if (selectedPath === '') return
    const title = nameInput.value.trim() || folderName(selectedPath)
    create.disabled = true
    cancel.disabled = true
    create.textContent = flow.t('dialog.creating')
    void (async () => {
      try {
        if (destination.kind === 'local') {
          const local = await flow.api.createLocalWorkspace({ path: selectedPath, title })
          close()
          flow.ctx.uiWorkspace.startSession(local.workspaceId as never)
          return
        }
        const workspace = await flow.api.createWorkspace(destination.host.id, {
          path: selectedPath,
          title,
        })
        const localId = await waitForLocalWorkspace(flow.api, destination.host.id, workspace.workspaceId)
        if (localId === undefined) {
          error.textContent = flow.t('dialog.selectedFallback')
          create.disabled = false
          cancel.disabled = false
          create.textContent = flow.t('dialog.create')
          return
        }
        const session = await flow.api.startBlankSession(destination.host.id, { localWorkspaceId: localId })
        close()
        flow.api.openSession(session.localSessionId)
      } catch (failure) {
        error.textContent = localizedError(flow.t, failure, flow.t('dialog.createFailed'))
        create.disabled = false
        cancel.disabled = false
        create.textContent = flow.t('dialog.create')
      }
    })()
  })

  nameInput.focus()
}

function openDestinationMenu(
  anchor: HTMLElement,
  hosts: readonly HostView[],
  current: Destination,
  t: Translate,
  onPick: (destination: Destination) => void,
): void {
  closeMenu?.()
  const menu = document.createElement('div')
  menu.className = `${DIALOG_CLASS}-destination-menu`
  const add = (label: string, destination: Destination): void => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `${DIALOG_CLASS}-destination-item`
    const text = document.createElement('span')
    text.textContent = label
    const check = document.createElement('span')
    check.className = `${DIALOG_CLASS}-destination-check`
    const selected = current.kind === destination.kind
      && (destination.kind === 'local' || (current.kind === 'remote' && current.host.id === destination.host.id))
    check.textContent = selected ? '✓' : ''
    item.append(text, check)
    item.addEventListener('click', () => {
      onPick(destination)
      close()
    })
    menu.append(item)
  }
  add(t('dialog.local'), { kind: 'local' })
  if (hosts.length > 0) {
    const section = document.createElement('div')
    section.className = `${DIALOG_CLASS}-destination-section`
    section.textContent = t('dialog.remoteDevices')
    menu.append(section)
    for (const host of hosts) add(host.label, { kind: 'remote', host })
  }
  document.body.append(menu)
  const rect = anchor.getBoundingClientRect()
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`
  menu.style.top = `${rect.bottom + 6}px`
  const close = (): void => {
    menu.remove()
    window.removeEventListener('pointerdown', dismiss, true)
    if (closeMenu === close) closeMenu = undefined
  }
  closeMenu = close
  const dismiss = (event: Event): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return
    close()
  }
  window.addEventListener('pointerdown', dismiss, true)
}

async function openDirectoryBrowser(
  flow: WorkspaceFlowContext,
  destination: Destination,
  initialPath: string,
  onPick: (path: string) => void,
): Promise<void> {
  closeBrowser?.()
  const overlay = document.createElement('div')
  overlay.className = `${DIALOG_CLASS}-browser-overlay`
  overlay.setAttribute('role', 'presentation')
  const dialog = document.createElement('div')
  dialog.className = `${DIALOG_CLASS} ${DIALOG_CLASS}-browser`
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', flow.t('dialog.folderTitle'))

  const title = document.createElement('h2')
  title.className = `${DIALOG_CLASS}-title`
  title.textContent = flow.t('dialog.folderTitle')
  const browserHeader = document.createElement('div')
  browserHeader.className = `${DIALOG_CLASS}-header`
  const browserClose = document.createElement('button')
  browserClose.type = 'button'
  browserClose.className = `${DIALOG_CLASS}-close`
  browserClose.setAttribute('aria-label', flow.t('dialog.close'))
  browserClose.textContent = '×'
  browserHeader.append(title, browserClose)
  const pathRow = document.createElement('div')
  pathRow.className = `${DIALOG_CLASS}-browser-path-row`
  const up = document.createElement('button')
  up.type = 'button'
  up.className = `${DIALOG_CLASS}-up`
  up.textContent = '↑'
  up.setAttribute('aria-label', flow.t('dialog.up'))
  const pathInput = document.createElement('input')
  pathInput.className = `${DIALOG_CLASS}-browser-path`
  pathInput.value = initialPath
  pathInput.autocomplete = 'off'
  pathRow.append(up, pathInput)
  const status = document.createElement('p')
  status.className = `${DIALOG_CLASS}-browser-status`
  status.textContent = flow.t('dialog.selectFolder')
  const list = document.createElement('div')
  list.className = `${DIALOG_CLASS}-browser-list`
  const actions = document.createElement('div')
  actions.className = `${DIALOG_CLASS}-actions`
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = `${DIALOG_CLASS}-button`
  cancel.textContent = flow.t('dialog.cancel')
  const use = document.createElement('button')
  use.type = 'button'
  use.className = `${DIALOG_CLASS}-button ${DIALOG_CLASS}-primary`
  use.textContent = flow.t('dialog.useFolder')
  actions.append(cancel, use)
  dialog.append(browserHeader, pathRow, status, list, actions)
  overlay.append(dialog)
  document.body.append(overlay)

  let current = initialPath
  let parent = initialPath
  let currentEntries: readonly { readonly name: string; readonly path: string }[] = []
  let requestSeq = 0
  let filterTimer: number | undefined

  const fetchListing = async (path: string): Promise<DirectoryListing | undefined> => {
    const sequence = ++requestSeq
    status.textContent = flow.t('dialog.reading')
    status.classList.remove(`${DIALOG_CLASS}-error-text`)
    try {
      const listing: DirectoryListing = destination.kind === 'local'
        ? await flow.api.listLocalDirectories(path)
        : await flow.api.listDirectories(destination.host.id, path)
      if (sequence !== requestSeq) return undefined
      return listing
    } catch (failure) {
      if (sequence === requestSeq) {
        status.textContent = localizedError(flow.t, failure, flow.t('dialog.readFailed'))
        status.classList.add(`${DIALOG_CLASS}-error-text`)
      }
      return undefined
    }
  }

  const render = (entries: readonly { readonly name: string; readonly path: string }[]): void => {
    list.replaceChildren()
    if (entries.length === 0) {
      const empty = document.createElement('p')
      empty.className = `${DIALOG_CLASS}-browser-empty`
      empty.textContent = flow.t('dialog.emptyFolder')
      list.append(empty)
      return
    }
    for (const entry of entries) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = `${DIALOG_CLASS}-browser-entry`
      const icon = document.createElement('span')
      icon.textContent = '📁'
      const label = document.createElement('span')
      label.textContent = entry.name
      item.append(icon, label)
      item.addEventListener('click', () => { void load(entry.path) })
      list.append(item)
    }
  }

  const load = async (path: string, preserveInput = false): Promise<void> => {
    const listing = await fetchListing(path)
    if (listing === undefined) return
    current = listing.path
    parent = listing.parent
    currentEntries = listing.entries
    if (!preserveInput) pathInput.value = listing.path
    status.textContent = flow.t('dialog.selectFolder')
    render(listing.entries)
  }

  const applyInputFilter = async (raw: string): Promise<void> => {
    if (raw === '') return
    const slash = raw.lastIndexOf('/')
    const dir = slash < 0 ? current : (raw.slice(0, slash + 1) || '/')
    const query = slash < 0 ? raw : raw.slice(slash + 1)
    if (query === '') {
      // A trailing slash is an explicit directory navigation. Keep the user's
      // typed value so the next path segment can be typed after it.
      await load(raw, true)
      return
    }
    const normalizedCurrent = current.replace(/\/+$/u, '') || '/'
    const normalizedDir = dir.replace(/\/+$/u, '') || '/'
    if (normalizedDir === normalizedCurrent) {
      const needle = query.toLocaleLowerCase()
      render(currentEntries.filter(entry => entry.name.toLocaleLowerCase().startsWith(needle)))
      status.textContent = flow.t('dialog.selectFolder')
      return
    }
    const listing = await fetchListing(dir)
    if (listing === undefined) return
    current = listing.path
    parent = listing.parent
    currentEntries = listing.entries
    const needle = query.toLocaleLowerCase()
    render(listing.entries.filter(entry => entry.name.toLocaleLowerCase().startsWith(needle)))
    status.textContent = flow.t('dialog.selectFolder')
  }

  const close = (): void => {
    overlay.remove()
    window.removeEventListener('keydown', keyHandler, true)
    overlay.removeEventListener('pointerdown', outside, true)
    if (closeBrowser === close) closeBrowser = undefined
  }
  closeBrowser = close
  const keyHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  const outside = (event: Event): void => {
    if (event.target === overlay) close()
  }
  window.addEventListener('keydown', keyHandler, true)
  overlay.addEventListener('pointerdown', outside, true)
  cancel.addEventListener('click', close)
  browserClose.addEventListener('click', close)
  use.addEventListener('click', () => {
    onPick(current)
    close()
  })
  up.addEventListener('click', () => {
    if (parent !== '' && parent !== current) void load(parent)
  })
  pathInput.addEventListener('input', () => {
    if (filterTimer !== undefined) window.clearTimeout(filterTimer)
    const value = pathInput.value
    filterTimer = window.setTimeout(() => { void applyInputFilter(value) }, 140)
  })
  pathInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const value = pathInput.value.trim()
    if (value !== '') void applyInputFilter(value)
  })
  void load(initialPath)
}

async function waitForLocalWorkspace(api: HostsApi, hostId: string, workspaceId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await api.workspaces(hostId)
    const workspace = result.workspaces.find(item => item.workspaceId === workspaceId)
    if (workspace?.localWorkspaceId !== undefined) return workspace.localWorkspaceId
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return undefined
}

function closeTransient(): void {
  closeDialog?.()
  closeBrowser?.()
  closeMenu?.()
}


function folderName(path: string): string {
  const clean = path.replace(/[\\/]+$/u, '')
  const parts = clean.split(/[\\/]+/u)
  return parts[parts.length - 1] ?? clean
}

function setComputerIcon(icon: HTMLElement): void {
  icon.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="12" rx="1.7" stroke="currentColor" stroke-width="1.5"/><path d="M8 20h8M12 17v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
}

/**
 * Dialog styling.
 *
 * Every value comes from the Harness design tokens (`--dsw-*`), never a literal
 * colour: the alias layer is what a theme or skin plugin overrides, so the
 * dialog follows whatever theme the user runs. Metrics mirror DSH's own
 * workspace browser (12–14px type, 28–36px controls, 4–8px rhythm).
 */
function ensureStyles(): void {
  const existing = document.getElementById('dshr-workspace-add-style')
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
  style.id = 'dshr-workspace-add-style'
  style.textContent = `
    .${DIALOG_CLASS}-overlay {
      position: fixed; inset: 0; z-index: 100001; display: grid; place-items: center;
      padding: 24px; background: var(--dsw-alias-bg-mask-3);
    }
    .${DIALOG_CLASS} {
      width: min(520px, calc(100vw - 48px));
      box-sizing: border-box; padding: 20px; display: flex; flex-direction: column; gap: 16px;
      border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l4);
      background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
      box-shadow: 0 24px 64px var(--dsw-alias-bg-mask-3);
      font: 13px/20px var(--dsw-font-family, inherit);
    }
    .${DIALOG_CLASS}-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .${DIALOG_CLASS}-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
    .${DIALOG_CLASS}-close {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; padding: 0; border: 0; border-radius: var(--dsw-radius-xs);
      background: transparent; color: var(--dsw-alias-label-tertiary);
      font-size: 18px; line-height: 1; cursor: pointer;
    }
    .${DIALOG_CLASS}-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
    .${DIALOG_CLASS}-form { display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: center; gap: 8px 12px; }
    .${DIALOG_CLASS}-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
    .${DIALOG_CLASS}-control {
      width: 100%; box-sizing: border-box; height: 30px; padding: 0 8px;
      border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
      background: transparent; color: var(--dsw-alias-label-primary);
      font: inherit; font-size: 13px; outline: none;
    }
    .${DIALOG_CLASS}-control::placeholder { color: var(--dsw-alias-label-dimmed); }
    .${DIALOG_CLASS}-control:focus { border-color: var(--dsw-alias-link); box-shadow: 0 0 0 2px var(--dsw-alias-interactive-bg-hover-accent); }
    .${DIALOG_CLASS}-select {
      display: flex; align-items: center; gap: 8px;
      text-align: left; cursor: pointer;
    }
    .${DIALOG_CLASS}-select:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .${DIALOG_CLASS}-control-icon { flex: none; display: inline-flex; color: var(--dsw-alias-label-tertiary); }
    .${DIALOG_CLASS}-control-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${DIALOG_CLASS}-chevron { flex: none; color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 1; }
    .${DIALOG_CLASS}-control-row { display: flex; gap: 8px; min-width: 0; }
    .${DIALOG_CLASS}-browse {
      flex: none; height: 30px; padding: 0 12px;
      border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
      background: transparent; color: var(--dsw-alias-label-secondary);
      font: inherit; font-size: 12px; cursor: pointer;
    }
    .${DIALOG_CLASS}-browse:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
    .${DIALOG_CLASS}-browse:disabled { opacity: .5; cursor: default; }
    .${DIALOG_CLASS}-error {
      grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-state-error-primary);
      font-size: 12px; line-height: 18px; white-space: pre-wrap;
    }
    .${DIALOG_CLASS}-error:empty { display: none; }
    .${DIALOG_CLASS}-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .${DIALOG_CLASS}-button {
      height: 30px; padding: 0 14px;
      border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
      background: transparent; color: var(--dsw-alias-label-primary);
      font: inherit; font-size: 13px; cursor: pointer;
    }
    .${DIALOG_CLASS}-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
    .${DIALOG_CLASS}-button:disabled { opacity: .45; cursor: default; }
    .${DIALOG_CLASS}-primary {
      border-color: var(--dsw-alias-button-primary-fill);
      background: var(--dsw-alias-button-primary-fill);
      color: var(--dsw-alias-label-primary-inverted);
      font-weight: 500;
    }
    .${DIALOG_CLASS}-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
    .${DIALOG_CLASS}-destination-menu {
      position: fixed; z-index: 100010; min-width: 220px; max-width: 320px; padding: 4px;
      border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l4);
      background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
      box-shadow: 0 16px 40px var(--dsw-alias-bg-mask-3);
      font: 13px/20px var(--dsw-font-family, inherit);
    }
    .${DIALOG_CLASS}-destination-item {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      width: 100%; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-xs);
      background: transparent; color: inherit; font: inherit; cursor: pointer; text-align: left;
    }
    .${DIALOG_CLASS}-destination-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .${DIALOG_CLASS}-destination-section {
      padding: 8px 8px 4px; color: var(--dsw-alias-label-caption);
      font-size: 11px; line-height: 16px;
    }
    .${DIALOG_CLASS}-destination-check { color: var(--dsw-alias-label-secondary); }
    .${DIALOG_CLASS}-browser-overlay {
      position: fixed; inset: 0; z-index: 100002; display: grid; place-items: center;
      padding: 24px; background: var(--dsw-alias-bg-mask-3);
    }
    .${DIALOG_CLASS}-browser { width: min(560px, calc(100vw - 48px)); max-height: 80vh; }
    .${DIALOG_CLASS}-browser-path-row { display: flex; gap: 8px; align-items: center; }
    .${DIALOG_CLASS}-up {
      flex: none; width: 30px; height: 30px; padding: 0;
      border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
      background: transparent; color: var(--dsw-alias-label-secondary); font-size: 14px; cursor: pointer;
    }
    .${DIALOG_CLASS}-up:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .${DIALOG_CLASS}-browser-path {
      flex: 1; min-width: 0; height: 30px; padding: 0 8px; box-sizing: border-box;
      border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
      background: transparent; color: var(--dsw-alias-label-primary);
      font: inherit; font-size: 13px; outline: none;
    }
    .${DIALOG_CLASS}-browser-path:focus { border-color: var(--dsw-alias-link); }
    .${DIALOG_CLASS}-browser-status { margin: 0; color: var(--dsw-alias-label-caption); font-size: 12px; line-height: 18px; }
    .${DIALOG_CLASS}-browser-list {
      flex: 1; min-height: 200px; max-height: 380px; overflow: auto; padding: 4px;
      border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
    }
    .${DIALOG_CLASS}-browser-entry {
      display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
      padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-xs);
      background: transparent; color: var(--dsw-alias-label-primary);
      font: inherit; font-size: 13px; text-align: left; cursor: pointer;
    }
    .${DIALOG_CLASS}-browser-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .${DIALOG_CLASS}-browser-empty { margin: 12px 8px; color: var(--dsw-alias-label-caption); font-size: 12px; }
    .${DIALOG_CLASS}-error-text { color: var(--dsw-alias-state-error-primary); }
  `
  if (existing === null) document.head.append(style)
}
