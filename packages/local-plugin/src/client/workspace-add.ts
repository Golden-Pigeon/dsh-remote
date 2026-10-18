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

const ADD_LABELS = new Set(['Add workspace', '添加工作区'])
const NATIVE_CLICK_FLAG = 'dshrNativeClick'
const DIALOG_CLASS = 'dshr-workspace-add-dialog'
let closeDialog: (() => void) | undefined
let closeBrowser: (() => void) | undefined
let closeMenu: (() => void) | undefined

interface WorkspaceFlowContext {
  readonly ctx: Context
  readonly api: HostsApi
}

type Destination = { readonly kind: 'local' } | { readonly kind: 'remote'; readonly host: HostView }

interface DirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly { readonly name: string; readonly path: string }[]
  readonly truncated: boolean
}

/** Install the sidebar add-workspace dialog once per client mount. */
export function installWorkspaceAddMenu(ctx: Context, api: HostsApi): void {
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
      void openCreateDialog({ ctx, api }, button)
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
  dialog.setAttribute('aria-label', '新建工作区')

  const title = document.createElement('h2')
  title.className = `${DIALOG_CLASS}-title`
  title.textContent = '新建工作区'

  const nameLabel = document.createElement('label')
  nameLabel.className = `${DIALOG_CLASS}-field`
  const nameText = document.createElement('span')
  nameText.textContent = '工作区名称'
  const nameRow = document.createElement('div')
  nameRow.className = `${DIALOG_CLASS}-input-row`
  const nameIcon = document.createElement('span')
  nameIcon.className = `${DIALOG_CLASS}-input-icon`
  setFolderIcon(nameIcon)
  const nameInput = document.createElement('input')
  nameInput.className = `${DIALOG_CLASS}-input`
  nameInput.placeholder = '工作区名称'
  nameInput.autocomplete = 'off'
  nameRow.append(nameIcon, nameInput)
  nameLabel.append(nameText, nameRow)

  const sourceTitle = document.createElement('h3')
  sourceTitle.className = `${DIALOG_CLASS}-section-title`
  sourceTitle.textContent = '源目录'
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
  addFolderText.textContent = '添加'
  addFolder.append(addFolderIcon, addFolderText)
  sourceCenter.append(sourceTrigger, addFolder)
  sourceBox.append(sourceCenter)

  const error = document.createElement('p')
  error.className = `${DIALOG_CLASS}-error`
  error.setAttribute('role', 'alert')

  const actions = document.createElement('div')
  actions.className = `${DIALOG_CLASS}-actions`
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = `${DIALOG_CLASS}-button`
  cancel.textContent = '取消'
  const create = document.createElement('button')
  create.type = 'button'
  create.className = `${DIALOG_CLASS}-button ${DIALOG_CLASS}-primary`
  create.textContent = '创建工作区'
  actions.append(cancel, create)

  dialog.append(title, nameLabel, sourceTitle, sourceBox, error, actions)
  overlay.append(dialog)
  document.body.append(overlay)

  let hosts: HostView[] = []
  let destination: Destination = { kind: 'local' }
  let selectedPath = ''
  const update = (): void => {
    const label = destination.kind === 'local' ? '本机' : destination.host.label
    sourceTriggerText.textContent = `将目录添加到 ${label}`
    addFolderIcon.textContent = selectedPath === '' ? '+ ' : '✓ '
    create.disabled = nameInput.value.trim() === '' || selectedPath === ''
    const last = sourceBox.querySelector(`.${DIALOG_CLASS}-selected-folder`)
    last?.remove()
    if (selectedPath !== '') {
      const row = document.createElement('div')
      row.className = `${DIALOG_CLASS}-selected-folder`
      const icon = document.createElement('span')
      icon.textContent = '📁'
      const text = document.createElement('span')
      text.textContent = selectedPath
      row.append(icon, text)
      sourceBox.append(row)
    }
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

  sourceTrigger.addEventListener('click', () => {
    openDestinationMenu(sourceTrigger, hosts, destination, next => {
      destination = next
      selectedPath = ''
      update()
    })
  })
  addFolder.addEventListener('click', () => {
    const initial = destination.kind === 'local'
      ? '~'
      : destination.host.hostInfo?.home ?? '~'
    openDirectoryBrowser(flow, destination, initial, path => {
      selectedPath = path
      update()
    })
  })
  nameInput.addEventListener('input', update)

  try {
    const state = await flow.api.state()
    hosts = state.hosts.filter(host => host.phase === 'connected')
  } catch {
    hosts = []
  }
  if (hosts.length === 0) {
    error.textContent = '还没有已连接的远端主机；当前仍可在本机创建。'
  }
  update()
  create.addEventListener('click', () => {
    const title = nameInput.value.trim()
    if (title === '' || selectedPath === '') return
    create.disabled = true
    cancel.disabled = true
    create.textContent = '创建中…'
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
        if (localId === undefined) throw new Error('远端 workspace 已创建，但本地镜像还没有同步完成')
        close()
        flow.ctx.uiWorkspace.startSession(localId as never)
      } catch (failure) {
        error.textContent = messageOf(failure, '新建工作区失败')
        create.disabled = false
        cancel.disabled = false
        create.textContent = '创建工作区'
      }
    })()
  })

  nameInput.focus()
}

function openDestinationMenu(
  anchor: HTMLElement,
  hosts: readonly HostView[],
  current: Destination,
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
  add('本机', { kind: 'local' })
  if (hosts.length > 0) {
    const section = document.createElement('div')
    section.className = `${DIALOG_CLASS}-destination-section`
    section.textContent = '远端设备'
    menu.append(section)
    for (const host of hosts) add(host.label, { kind: 'remote', host })
  }
  const addRemote = document.createElement('button')
  addRemote.type = 'button'
  addRemote.className = `${DIALOG_CLASS}-destination-item ${DIALOG_CLASS}-destination-add`
  addRemote.textContent = '+ 添加远端…'
  addRemote.addEventListener('click', () => {
    close()
    const error = document.querySelector(`.${DIALOG_CLASS}-error`)
    if (error !== null) error.textContent = '请先在 Settings → 远程开发 添加并连接远端主机。'
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
  dialog.setAttribute('aria-label', '选择源目录')

  const title = document.createElement('h2')
  title.className = `${DIALOG_CLASS}-browser-title`
  title.textContent = '选择源目录'
  const pathRow = document.createElement('div')
  pathRow.className = `${DIALOG_CLASS}-browser-path-row`
  const up = document.createElement('button')
  up.type = 'button'
  up.className = `${DIALOG_CLASS}-up`
  up.textContent = '↑'
  up.setAttribute('aria-label', '上一级')
  const pathInput = document.createElement('input')
  pathInput.className = `${DIALOG_CLASS}-browser-path`
  pathInput.value = initialPath
  pathInput.autocomplete = 'off'
  pathRow.append(up, pathInput)
  const status = document.createElement('p')
  status.className = `${DIALOG_CLASS}-browser-status`
  status.textContent = '选择当前目录'
  const list = document.createElement('div')
  list.className = `${DIALOG_CLASS}-browser-list`
  const actions = document.createElement('div')
  actions.className = `${DIALOG_CLASS}-actions`
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = `${DIALOG_CLASS}-button`
  cancel.textContent = '取消'
  const use = document.createElement('button')
  use.type = 'button'
  use.className = `${DIALOG_CLASS}-button ${DIALOG_CLASS}-primary`
  use.textContent = '使用此目录'
  actions.append(cancel, use)
  dialog.append(title, pathRow, status, list, actions)
  overlay.append(dialog)
  document.body.append(overlay)

  let current = initialPath
  let parent = initialPath
  let busy = false
  const load = async (path: string): Promise<void> => {
    if (busy) return
    busy = true
    status.textContent = '正在读取目录…'
    list.replaceChildren()
    try {
      const listing: DirectoryListing = destination.kind === 'local'
        ? await flow.api.listLocalDirectories(path)
        : await flow.api.listDirectories(destination.host.id, path)
      current = listing.path
      parent = listing.parent
      pathInput.value = listing.path
      status.textContent = '选择当前目录'
      for (const entry of listing.entries) {
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
      if (listing.entries.length === 0) {
        const empty = document.createElement('p')
        empty.className = `${DIALOG_CLASS}-browser-empty`
        empty.textContent = '此目录没有子目录'
        list.append(empty)
      }
    } catch (failure) {
      status.textContent = messageOf(failure, '读取目录失败')
    } finally {
      busy = false
    }
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
  use.addEventListener('click', () => {
    onPick(current)
    close()
  })
  up.addEventListener('click', () => {
    if (parent !== '' && parent !== current) void load(parent)
  })
  pathInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const value = pathInput.value.trim()
    if (value !== '') void load(value)
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

function messageOf(failure: unknown, fallback: string): string {
  if (failure instanceof Error && failure.message !== '') return failure.message
  return fallback
}

function setFolderIcon(icon: HTMLElement): void {
  icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z" stroke="currentColor" stroke-width="1.5"/></svg>'
}

function ensureStyles(): void {
  if (document.getElementById('dshr-workspace-add-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dshr-workspace-add-style'
  style.textContent = `
    .${DIALOG_CLASS}-overlay {
      position: fixed; inset: 0; z-index: 100001; display: grid; place-items: center;
      padding: 24px; background: rgba(0,0,0,.55);
    }
    .${DIALOG_CLASS} {
      width: 720px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 30px;
      border-radius: 18px; border: 1px solid rgba(255,255,255,.1);
      background: #242424; color: #f2f2f2; box-shadow: 0 28px 80px rgba(0,0,0,.65);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .${DIALOG_CLASS}-title {
      margin: 0 0 24px; font-size: 30px; line-height: 1.1; font-weight: 700; letter-spacing: -.02em;
    }
    .${DIALOG_CLASS}-field { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
    .${DIALOG_CLASS}-field > span { font-size: 13px; color: rgba(255,255,255,.72); }
    .${DIALOG_CLASS}-input-row { display: flex; align-items: center; gap: 10px; border: 1px solid rgba(255,255,255,.24); border-radius: 10px; padding: 0 14px; background: transparent; }
    .${DIALOG_CLASS}-input-icon { display: inline-flex; color: rgba(255,255,255,.7); }
    .${DIALOG_CLASS}-input { width: 100%; border: 0; outline: none; background: transparent; color: inherit; font: inherit; padding: 14px 0; }
    .${DIALOG_CLASS}-section-title { margin: 4px 0 10px; font-size: 13px; font-weight: 600; color: rgba(255,255,255,.72); }
    .${DIALOG_CLASS}-source-box { position: relative; border: 1px solid rgba(255,255,255,.16); border-radius: 12px; padding: 28px 20px 16px; min-height: 130px; display: flex; flex-direction: column; align-items: center; }
    .${DIALOG_CLASS}-source-center { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .${DIALOG_CLASS}-source-trigger { display: inline-flex; align-items: center; gap: 8px; border: 0; background: transparent; color: rgba(255,255,255,.75); font: inherit; font-size: 16px; cursor: pointer; }
    .${DIALOG_CLASS}-source-trigger span:first-child { color: #fff; font-weight: 600; }
    .${DIALOG_CLASS}-chevron { font-size: 18px; line-height: 1; }
    .${DIALOG_CLASS}-add-folder { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 9px; padding: 9px 16px; background: rgba(255,255,255,.12); color: #fff; font: inherit; cursor: pointer; }
    .${DIALOG_CLASS}-add-folder:hover { background: rgba(255,255,255,.18); }
    .${DIALOG_CLASS}-add-folder-icon { font-size: 18px; line-height: 1; }
    .${DIALOG_CLASS}-selected-folder { display: flex; gap: 8px; align-items: center; max-width: 100%; margin-top: 18px; padding: 8px 12px; border-radius: 8px; background: rgba(255,255,255,.07); color: rgba(255,255,255,.86); font-size: 13px; overflow: hidden; }
    .${DIALOG_CLASS}-selected-folder span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${DIALOG_CLASS}-error { min-height: 18px; margin: 12px 0 0; color: #ff8b8b; font-size: 12px; white-space: pre-wrap; }
    .${DIALOG_CLASS}-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 26px; }
    .${DIALOG_CLASS}-button { padding: 10px 16px; border-radius: 9px; border: 1px solid rgba(255,255,255,.18); background: transparent; color: #eee; cursor: pointer; font: inherit; }
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
    .${DIALOG_CLASS}-browser-title { margin: 0 0 20px; font-size: 26px; line-height: 1.15; font-weight: 700; }
    .${DIALOG_CLASS}-browser-path-row { display: flex; align-items: center; gap: 8px; }
    .${DIALOG_CLASS}-up { flex: none; width: 34px; height: 34px; border: 0; background: transparent; color: rgba(255,255,255,.65); font-size: 22px; cursor: pointer; }
    .${DIALOG_CLASS}-browser-path { flex: 1; border: 1px solid rgba(255,255,255,.22); border-radius: 9px; background: transparent; color: #fff; font: inherit; font-size: 16px; padding: 12px 14px; outline: none; }
    .${DIALOG_CLASS}-browser-status { margin: 14px 0 8px; color: rgba(255,255,255,.55); font-size: 13px; }
    .${DIALOG_CLASS}-browser-list { flex: 1; min-height: 220px; max-height: 420px; overflow: auto; border: 1px solid rgba(255,255,255,.16); border-radius: 12px; padding: 6px; }
    .${DIALOG_CLASS}-browser-entry { display: flex; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; padding: 11px 12px; border: 0; border-radius: 8px; background: transparent; color: #fff; font: inherit; font-size: 16px; text-align: left; cursor: pointer; }
    .${DIALOG_CLASS}-browser-entry:hover { background: rgba(255,255,255,.08); }
    .${DIALOG_CLASS}-browser-empty { margin: 16px 12px; color: rgba(255,255,255,.5); font-size: 13px; }
  `
  document.head.append(style)
}
