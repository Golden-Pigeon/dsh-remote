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

  const nameLabel = document.createElement('label')
  nameLabel.className = `${DIALOG_CLASS}-field`
  const nameText = document.createElement('span')
  nameText.textContent = flow.t('dialog.name')
  const nameRow = document.createElement('div')
  nameRow.className = `${DIALOG_CLASS}-input-row`
  const nameIcon = document.createElement('span')
  nameIcon.className = `${DIALOG_CLASS}-input-icon`
  setFolderIcon(nameIcon)
  const nameInput = document.createElement('input')
  nameInput.className = `${DIALOG_CLASS}-input`
  nameInput.placeholder = flow.t('dialog.namePlaceholder')
  nameInput.autocomplete = 'off'
  nameRow.append(nameIcon, nameInput)
  nameLabel.append(nameText, nameRow)

  const sourceTitle = document.createElement('h3')
  sourceTitle.className = `${DIALOG_CLASS}-section-title`
  sourceTitle.textContent = flow.t('dialog.source')
  const sourceHeader = document.createElement('div')
  sourceHeader.className = `${DIALOG_CLASS}-source-header`
  const hostIndicator = document.createElement('span')
  hostIndicator.className = `${DIALOG_CLASS}-host-indicator`
  const hostIcon = document.createElement('span')
  hostIcon.className = `${DIALOG_CLASS}-host-icon`
  setComputerIcon(hostIcon)
  const hostLabelText = document.createElement('span')
  hostIndicator.append(hostIcon, hostLabelText)
  sourceHeader.append(sourceTitle, hostIndicator)
  const sourceBox = document.createElement('div')
  sourceBox.className = `${DIALOG_CLASS}-source-box`
  const sourceCenter = document.createElement('div')
  sourceCenter.className = `${DIALOG_CLASS}-source-center`
  const sourceTrigger = document.createElement('button')
  sourceTrigger.type = 'button'
  sourceTrigger.className = `${DIALOG_CLASS}-source-trigger`
  const sourceTriggerText = document.createElement('span')
  const sourceChevron = document.createElement('span')
  sourceChevron.className = `${DIALOG_CLASS}-chevron`
  sourceChevron.textContent = '⌄'
  sourceTrigger.append(sourceTriggerText, sourceChevron)
  const addFolder = document.createElement('button')
  addFolder.type = 'button'
  addFolder.className = `${DIALOG_CLASS}-add-folder`
  const addFolderIcon = document.createElement('span')
  addFolderIcon.className = `${DIALOG_CLASS}-add-folder-icon`
  const addFolderText = document.createElement('span')
  addFolderText.textContent = flow.t('dialog.add')
  addFolder.append(addFolderIcon, addFolderText)
  sourceCenter.append(sourceTrigger, addFolder)
  const selectedFolder = document.createElement('div')
  selectedFolder.className = `${DIALOG_CLASS}-selected-folder`
  const selectedIcon = document.createElement('span')
  selectedIcon.textContent = '📁'
  const selectedName = document.createElement('span')
  selectedName.className = `${DIALOG_CLASS}-selected-name`
  const removeFolder = document.createElement('button')
  removeFolder.type = 'button'
  removeFolder.className = `${DIALOG_CLASS}-remove-folder`
  removeFolder.setAttribute('aria-label', flow.t('dialog.removeFolder'))
  removeFolder.textContent = '×'
  selectedFolder.append(selectedIcon, selectedName, removeFolder)
  sourceBox.append(sourceCenter, selectedFolder)

  const error = document.createElement('p')
  error.className = `${DIALOG_CLASS}-error`
  error.setAttribute('role', 'alert')

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

  dialog.append(header, nameLabel, sourceHeader, sourceBox, error, actions)
  overlay.append(dialog)
  document.body.append(overlay)

  let hosts: HostView[] = []
  let destination: Destination = { kind: 'local' }
  let selectedPath = ''
  const update = (): void => {
    const label = destination.kind === 'local' ? flow.t('dialog.local') : destination.host.label
    sourceTriggerText.textContent = `${flow.t('dialog.addToPrefix')}${label}${flow.t('dialog.addToSuffix')}`
    hostLabelText.textContent = label
    addFolderIcon.textContent = '+ '
    const hasFolder = selectedPath !== ''
    sourceCenter.style.display = hasFolder ? 'none' : 'flex'
    selectedFolder.style.display = hasFolder ? 'flex' : 'none'
    sourceBox.classList.toggle(`${DIALOG_CLASS}-source-box-selected`, hasFolder)
    selectedName.textContent = hasFolder ? folderName(selectedPath) : ''
    selectedFolder.title = hasFolder ? selectedPath : ''
    create.disabled = !hasFolder
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

  sourceTrigger.addEventListener('click', () => {
    openDestinationMenu(sourceTrigger, hosts, destination, flow.t, next => {
      destination = next
      selectedPath = ''
      update()
    })
  })
  addFolder.addEventListener('click', () => {
    if (destination.kind === 'local') {
      addFolder.disabled = true
      void pickLocalDirectory(flow.ctx)
        .then(path => {
          if (path !== null) {
            selectedPath = path
            update()
          }
        })
        .catch(failure => { error.textContent = localizedError(flow.t, failure, flow.t('dialog.nativePickerFailed')) })
        .finally(() => { addFolder.disabled = false })
      return
    }
    const initial = '~'
    openDirectoryBrowser(flow, destination, initial, path => {
      selectedPath = path
      update()
    })
  })
  removeFolder.addEventListener('click', () => {
    selectedPath = ''
    update()
  })
  nameInput.addEventListener('input', update)

  try {
    const state = await flow.api.state()
    hosts = state.hosts.filter(host => host.phase === 'connected')
  } catch {
    hosts = []
  }
  update()
  create.addEventListener('click', () => {
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
        const session = await flow.api.createSession(destination.host.id, {
          workspaceId: workspace.workspaceId,
        })
        if (session.localSessionId !== undefined) {
          close()
          flow.api.openSession(session.localSessionId)
          return
        }
        const localId = await waitForLocalWorkspace(flow.api, destination.host.id, workspace.workspaceId)
        if (localId === undefined) {
          error.textContent = flow.t('dialog.selectedFallback')
          create.disabled = false
          cancel.disabled = false
          create.textContent = flow.t('dialog.create')
          return
        }
        close()
        flow.ctx.uiWorkspace.startSession(localId as never)
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
  const addRemote = document.createElement('button')
  addRemote.type = 'button'
  addRemote.className = `${DIALOG_CLASS}-destination-item ${DIALOG_CLASS}-destination-add`
  addRemote.textContent = t('dialog.addRemote')
  addRemote.addEventListener('click', () => {
    close()
    const error = document.querySelector(`.${DIALOG_CLASS}-error`)
    if (error !== null) error.textContent = t('dialog.addRemoteHint')
  })
  menu.append(addRemote)
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
  title.className = `${DIALOG_CLASS}-browser-title`
  title.textContent = flow.t('dialog.folderTitle')
  const browserHeader = document.createElement('div')
  browserHeader.className = `${DIALOG_CLASS}-browser-header`
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


function setFolderIcon(icon: HTMLElement): void {
  icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z" stroke="currentColor" stroke-width="1.5"/></svg>'
}

function folderName(path: string): string {
  const clean = path.replace(/[\\/]+$/u, '')
  const parts = clean.split(/[\\/]+/u)
  return parts[parts.length - 1] ?? clean
}

function setComputerIcon(icon: HTMLElement): void {
  icon.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="12" rx="1.7" stroke="currentColor" stroke-width="1.5"/><path d="M8 20h8M12 17v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
}

function ensureStyles(): void {
  const existing = document.getElementById('dshr-workspace-add-style')
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
  style.id = 'dshr-workspace-add-style'
  style.textContent = `
    .${DIALOG_CLASS}-overlay {
      position: fixed; inset: 0; z-index: 100001; display: grid; place-items: center;
      padding: 24px; background: rgba(0,0,0,.55);
    }
    .${DIALOG_CLASS} {
      width: min(632px, calc(100vw - 48px));
      box-sizing: border-box; padding: 26px; display: flex; flex-direction: column;
      border-radius: 14px; border: 1px solid rgba(255,255,255,.1);
      background: #242424; color: #f2f2f2; box-shadow: 0 28px 80px rgba(0,0,0,.65);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .${DIALOG_CLASS}-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .${DIALOG_CLASS}-title { margin: 0; font-size: 28px; line-height: 1.1; font-weight: 700; letter-spacing: -.02em; }
    .${DIALOG_CLASS}-close { border: 0; background: transparent; color: rgba(255,255,255,.75); font-size: 30px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .${DIALOG_CLASS}-close:hover { color: #fff; }
    .${DIALOG_CLASS}-field { display: flex; flex-direction: column; gap: 7px; margin-bottom: 14px; }
    .${DIALOG_CLASS}-field > span { font-size: 13px; color: rgba(255,255,255,.72); }
    .${DIALOG_CLASS}-input-row { display: flex; align-items: center; gap: 10px; border: 1px solid rgba(255,255,255,.24); border-radius: 9px; padding: 0 12px; background: transparent; }
    .${DIALOG_CLASS}-input-icon { display: inline-flex; color: rgba(255,255,255,.7); }
    .${DIALOG_CLASS}-input { width: 100%; border: 0; outline: none; background: transparent; color: inherit; font: inherit; font-size: 14px; padding: 13px 0; }
    .${DIALOG_CLASS}-source-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 10px; }
    .${DIALOG_CLASS}-section-title { margin: 0; font-size: 17px; font-weight: 600; color: rgba(255,255,255,.92); }
    .${DIALOG_CLASS}-host-indicator { display: inline-flex; align-items: center; gap: 8px; color: rgba(255,255,255,.62); font-size: 15px; }
    .${DIALOG_CLASS}-host-icon { display: inline-flex; }
    .${DIALOG_CLASS}-source-box { position: relative; border: 1px solid rgba(255,255,255,.16); border-radius: 9px; padding: 24px 16px; min-height: 150px; flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .${DIALOG_CLASS}-source-center { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .${DIALOG_CLASS}-source-trigger { display: inline-flex; align-items: center; gap: 8px; border: 0; background: transparent; color: rgba(255,255,255,.75); font: inherit; font-size: 15px; cursor: pointer; }
    .${DIALOG_CLASS}-source-trigger span:first-child { color: #fff; font-weight: 600; }
    .${DIALOG_CLASS}-chevron { font-size: 18px; line-height: 1; }
    .${DIALOG_CLASS}-add-folder { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 8px; padding: 8px 14px; background: rgba(255,255,255,.12); color: #fff; font: inherit; font-size: 14px; cursor: pointer; }
    .${DIALOG_CLASS}-add-folder:hover { background: rgba(255,255,255,.18); }
    .${DIALOG_CLASS}-add-folder-icon { font-size: 18px; line-height: 1; }
    .${DIALOG_CLASS}-source-box-selected { padding: 0; min-height: 0; flex: none; justify-content: flex-start; }
    .${DIALOG_CLASS}-selected-folder { display: none; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; padding: 12px 14px; color: rgba(255,255,255,.92); font-size: 16px; }
    .${DIALOG_CLASS}-selected-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${DIALOG_CLASS}-remove-folder { flex: none; border: 0; background: transparent; color: rgba(255,255,255,.6); font-size: 24px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .${DIALOG_CLASS}-remove-folder:hover { color: #fff; }
    .${DIALOG_CLASS}-error { margin: 6px 0 0; color: #ff8b8b; font-size: 12px; white-space: pre-wrap; }
    .${DIALOG_CLASS}-error:empty { display: none; }
    .${DIALOG_CLASS}-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
    .${DIALOG_CLASS}-button { padding: 11px 18px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18); background: transparent; color: #eee; cursor: pointer; font: inherit; font-size: 15px; }
    .${DIALOG_CLASS}-button:disabled { opacity: .45; cursor: default; }
    .${DIALOG_CLASS}-primary { border-color: #bdbdbd; background: #bdbdbd; color: #1a1a1a; font-weight: 600; }
    .${DIALOG_CLASS}-primary:hover:not(:disabled) { background: #d0d0d0; }
    .${DIALOG_CLASS}-destination-menu {
      position: fixed; z-index: 100010; min-width: 250px; padding: 6px;
      border-radius: 12px; border: 1px solid rgba(255,255,255,.14); background: #2a2a2a; color: #eee;
      box-shadow: 0 18px 48px rgba(0,0,0,.55); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .${DIALOG_CLASS}-destination-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; text-align: left; }
    .${DIALOG_CLASS}-destination-item:hover { background: rgba(255,255,255,.09); }
    .${DIALOG_CLASS}-destination-section { padding: 14px 12px 6px; color: rgba(255,255,255,.5); font-size: 13px; }
    .${DIALOG_CLASS}-destination-check { color: #bdbdbd; }
    .${DIALOG_CLASS}-destination-add { color: rgba(255,255,255,.75); }
    .${DIALOG_CLASS}-browser-overlay { position: fixed; inset: 0; z-index: 100002; display: grid; place-items: center; background: rgba(0,0,0,.6); padding: 24px; }
    .${DIALOG_CLASS}-browser { width: 640px; max-height: 86vh; display: flex; flex-direction: column; padding: 26px; }
    .${DIALOG_CLASS}-browser-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    .${DIALOG_CLASS}-browser-title { margin: 0; font-size: 30px; line-height: 1.15; font-weight: 700; }
    .${DIALOG_CLASS}-browser-path-row { display: flex; align-items: center; gap: 8px; }
    .${DIALOG_CLASS}-up { flex: none; width: 34px; height: 34px; border: 0; background: transparent; color: rgba(255,255,255,.65); font-size: 22px; cursor: pointer; }
    .${DIALOG_CLASS}-browser-path { flex: 1; border: 1px solid rgba(255,255,255,.22); border-radius: 9px; background: transparent; color: #fff; font: inherit; font-size: 16px; padding: 12px 14px; outline: none; }
    .${DIALOG_CLASS}-browser-path:focus { border-color: #4f8cff; }
    .${DIALOG_CLASS}-browser-status { margin: 14px 0 8px; color: rgba(255,255,255,.55); font-size: 13px; }
    .${DIALOG_CLASS}-browser-list { flex: 1; min-height: 220px; max-height: 420px; overflow: auto; border: 1px solid rgba(255,255,255,.16); border-radius: 12px; padding: 6px; }
    .${DIALOG_CLASS}-browser-entry { display: flex; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; padding: 11px 12px; border: 0; border-radius: 8px; background: transparent; color: #fff; font: inherit; font-size: 16px; text-align: left; cursor: pointer; }
    .${DIALOG_CLASS}-browser-entry:hover { background: rgba(255,255,255,.08); }
    .${DIALOG_CLASS}-browser-empty { margin: 16px 12px; color: rgba(255,255,255,.5); font-size: 13px; }
  `
  if (existing === null) document.head.append(style)
}
