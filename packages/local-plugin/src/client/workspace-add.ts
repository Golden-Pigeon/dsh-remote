/**
 * Local/remote choice for the native sidebar "Add workspace" button.
 *
 * The sidebar button is owned by @deepseek-ai/dsh-client-ui-workspace and has
 * no public click hook. A document-level capture listener replaces that click
 * with a small chooser; the local branch replays the original click so the
 * shipped directory browser remains untouched. The remote branch uses the
 * existing authenticated host API and opens the mirrored session.
 *
 * @module dsh-remote-local/client/workspace-add
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostView } from '../hosts/types.ts'
import type { HostsApi } from './api.ts'

const ADD_LABELS = new Set(['Add workspace', '添加工作区'])
const NATIVE_CLICK_FLAG = 'dshrNativeClick'
const MENU_CLASS = 'dshr-workspace-add-menu'
const DIALOG_CLASS = 'dshr-workspace-add-dialog'
let dismissHandler: ((event: Event) => void) | undefined
let closeDialog: (() => void) | undefined

interface WorkspaceFlowContext {
  readonly ctx: Context
  readonly api: HostsApi
}

/** Install the sidebar add-workspace chooser once per client mount. */
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
      openChooser({ ctx, api }, button)
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      closeTransient()
    }
  }, 'dsh-remote: workspace add menu')
}

function openChooser(flow: WorkspaceFlowContext, button: HTMLButtonElement): void {
  closeTransient()
  const menu = document.createElement('div')
  menu.className = MENU_CLASS
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', '新建工作区')

  const addItem = (label: string, hint: string, action: () => void): void => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `${MENU_CLASS}-item`
    item.setAttribute('role', 'menuitem')
    const text = document.createElement('span')
    text.className = `${MENU_CLASS}-label`
    text.textContent = label
    const note = document.createElement('span')
    note.className = `${MENU_CLASS}-hint`
    note.textContent = hint
    item.append(text, note)
    item.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      action()
    })
    menu.append(item)
  }

  addItem('本地新建工作区', '使用本机目录选择器', () => {
    closeTransient()
    button.dataset[NATIVE_CLICK_FLAG] = '1'
    button.click()
  })
  addItem('远程新建工作区…', '在已连接的远端主机上创建', () => {
    closeTransient()
    void openRemoteDialog(flow)
  })

  document.body.append(menu)
  const rect = button.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - 260))}px`
  menu.style.top = `${Math.max(8, Math.min(rect.top - 4, window.innerHeight - 160))}px`

  const dismiss = (event: Event): void => {
    const target = event.target
    if (target instanceof Node && menu.contains(target)) return
    closeTransient()
  }
  dismissHandler = dismiss
  window.addEventListener('pointerdown', dismiss, true)
  window.addEventListener('keydown', onKeyDown, true)
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeTransient()
}

async function openRemoteDialog(flow: WorkspaceFlowContext): Promise<void> {
  closeTransient()
  const overlay = document.createElement('div')
  overlay.className = `${DIALOG_CLASS}-overlay`
  overlay.setAttribute('role', 'presentation')
  const dialog = document.createElement('div')
  dialog.className = DIALOG_CLASS
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', '远程新建工作区')

  const title = document.createElement('h2')
  title.className = `${DIALOG_CLASS}-title`
  title.textContent = '远程新建工作区'
  const subtitle = document.createElement('p')
  subtitle.className = `${DIALOG_CLASS}-subtitle`
  subtitle.textContent = '在已连接的远端主机上注册目录，并立即打开镜像会话。'

  const hostLabel = document.createElement('label')
  hostLabel.className = `${DIALOG_CLASS}-field`
  const hostText = document.createElement('span')
  hostText.textContent = '远端主机'
  const hostSelect = document.createElement('select')
  hostSelect.className = `${DIALOG_CLASS}-input`
  hostLabel.append(hostText, hostSelect)

  const pathLabel = document.createElement('label')
  pathLabel.className = `${DIALOG_CLASS}-field`
  const pathText = document.createElement('span')
  pathText.textContent = '远端目录'
  const pathInput = document.createElement('input')
  pathInput.className = `${DIALOG_CLASS}-input`
  pathInput.placeholder = '/home/user/project'
  pathInput.autocomplete = 'off'
  pathLabel.append(pathText, pathInput)

  const hiddenLabel = document.createElement('label')
  hiddenLabel.className = `${DIALOG_CLASS}-check`
  const hiddenInput = document.createElement('input')
  hiddenInput.type = 'checkbox'
  const hiddenText = document.createElement('span')
  hiddenText.textContent = '不显示在本地侧栏（临时/测试工作区）'
  hiddenLabel.append(hiddenInput, hiddenText)

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
  create.textContent = '创建并打开'
  actions.append(cancel, create)

  dialog.append(title, subtitle, hostLabel, pathLabel, hiddenLabel, error, actions)
  overlay.append(dialog)
  document.body.append(overlay)

  let hosts: HostView[] = []
  hostSelect.disabled = true
  create.disabled = true
  try {
    const state = await flow.api.state()
    hosts = state.hosts.filter(host => host.phase === 'connected')
    hostSelect.replaceChildren()
    for (const host of hosts) {
      const option = document.createElement('option')
      option.value = host.id
      option.textContent = `${host.label} · ${host.hostInfo?.hostname ?? host.sshTarget}`
      hostSelect.append(option)
    }
    if (hosts.length === 0) {
      error.textContent = '没有已连接的远端主机。请先在 Settings → 远程开发 里连接。'
    }
    hostSelect.disabled = hosts.length === 0
    create.disabled = hosts.length === 0
  } catch (failure) {
    error.textContent = messageOf(failure, '读取远端主机失败')
  }

  const close = (): void => {
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

  create.addEventListener('click', () => {
    const host = hosts.find(item => item.id === hostSelect.value)
    const path = pathInput.value.trim()
    if (host === undefined) {
      error.textContent = '请选择已连接的远端主机。'
      return
    }
    if (!path.startsWith('/')) {
      error.textContent = '请填写远端绝对路径，例如 /home/user/project。'
      return
    }
    error.textContent = ''
    create.disabled = true
    cancel.disabled = true
    create.textContent = '创建中…'
    void (async () => {
      try {
        const hidden = hiddenInput.checked
        const workspace = await flow.api.createWorkspace(host.id, {
          path,
          ...hidden ? { hidden: true } : {},
        })
        if (hidden) {
          close()
          return
        }
        const session = await flow.api.createSession(host.id, { workspaceId: workspace.workspaceId })
        if (session.localSessionId !== undefined) {
          close()
          flow.api.openSession(session.localSessionId)
          return
        }
        const localId = await waitForLocalWorkspace(flow.api, host.id, workspace.workspaceId)
        if (localId === undefined) throw new Error('远端 workspace 已创建，但本地镜像还没有同步完成')
        close()
        flow.ctx.uiWorkspace.startSession(localId as never)
      } catch (failure) {
        error.textContent = messageOf(failure, '远程新建工作区失败')
        create.disabled = false
        cancel.disabled = false
        create.textContent = '创建并打开'
      }
    })()
  })

  pathInput.focus()
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
  for (const node of document.querySelectorAll(`.${MENU_CLASS}`)) node.remove()
  closeDialog?.()
  if (dismissHandler !== undefined) {
    window.removeEventListener('pointerdown', dismissHandler, true)
    dismissHandler = undefined
  }
  window.removeEventListener('keydown', onKeyDown, true)
}

function messageOf(failure: unknown, fallback: string): string {
  if (failure instanceof Error && failure.message !== '') return failure.message
  return fallback
}

function ensureStyles(): void {
  if (document.getElementById('dshr-workspace-add-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dshr-workspace-add-style'
  style.textContent = `
    .${MENU_CLASS} {
      position: fixed; z-index: 100000; min-width: 240px; padding: 6px;
      border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
      background: #252526; color: #eee; box-shadow: 0 16px 40px rgba(0,0,0,.45);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .${MENU_CLASS}-item {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      width: 100%; padding: 9px 10px; border: 0; border-radius: 7px;
      background: transparent; color: inherit; text-align: left; cursor: pointer;
    }
    .${MENU_CLASS}-item:hover, .${MENU_CLASS}-item:focus-visible { background: rgba(255,255,255,.09); outline: none; }
    .${MENU_CLASS}-label { font-weight: 600; }
    .${MENU_CLASS}-hint { color: rgba(255,255,255,.55); font-size: 11px; }
    .${DIALOG_CLASS}-overlay {
      position: fixed; inset: 0; z-index: 100001; display: grid; place-items: center;
      background: rgba(0,0,0,.5); padding: 24px;
    }
    .${DIALOG_CLASS} {
      width: min(440px, 100%); padding: 20px; border-radius: 14px;
      border: 1px solid rgba(255,255,255,.14); background: #252526; color: #eee;
      box-shadow: 0 24px 70px rgba(0,0,0,.6);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .${DIALOG_CLASS}-title { margin: 0 0 4px; font-size: 16px; }
    .${DIALOG_CLASS}-subtitle { margin: 0 0 16px; color: rgba(255,255,255,.58); font-size: 12px; }
    .${DIALOG_CLASS}-field { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; font-size: 12px; color: rgba(255,255,255,.75); }
    .${DIALOG_CLASS}-input {
      width: 100%; box-sizing: border-box; padding: 9px 10px; border-radius: 7px;
      border: 1px solid rgba(255,255,255,.18); background: #1d1d1e; color: #eee;
      font: inherit; outline: none;
    }
    .${DIALOG_CLASS}-input:focus { border-color: #4f8cff; }
    .${DIALOG_CLASS}-check { display: flex; align-items: center; gap: 7px; margin: 12px 0; color: rgba(255,255,255,.72); font-size: 12px; }
    .${DIALOG_CLASS}-check input { margin: 0; }
    .${DIALOG_CLASS}-error { min-height: 18px; margin: 10px 0 0; color: #ff8b8b; font-size: 12px; white-space: pre-wrap; }
    .${DIALOG_CLASS}-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .${DIALOG_CLASS}-button {
      padding: 8px 12px; border-radius: 7px; border: 1px solid rgba(255,255,255,.18);
      background: transparent; color: #eee; cursor: pointer; font: inherit;
    }
    .${DIALOG_CLASS}-button:disabled { opacity: .55; cursor: default; }
    .${DIALOG_CLASS}-primary { border-color: #4f8cff; background: #4f8cff; color: white; }
  `
  document.head.append(style)
}
