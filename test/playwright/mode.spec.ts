import { expect, test } from '@playwright/test'
import { appAvailable, startE2EHost, type E2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial' })

test.describe('remote new-session mode selection', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')
  let host: E2EHost

  test.beforeAll(async () => { host = await startE2EHost() })
  test.afterAll(async () => { await host?.close() })

  async function dismissOverlays(): Promise<void> {
    const page = host.page
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 5_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Close' }).click({ timeout: 2_000 }).catch(() => {})
  }

  async function openBlank(workspaceName: RegExp): Promise<void> {
    const page = host.page
    const workspace = page.getByRole('treeitem', { name: workspaceName })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    const newSession = page.getByRole('button', { name: /New session in / })
    await expect(newSession).toBeVisible({ timeout: 10_000 })
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-remote')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await newSession.click()
    const response = await blankResponse
    expect(response.ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
  }

  async function selectMode(name: string): Promise<void> {
    const page = host.page
    const label = page.locator('button').filter({ hasText: new RegExp(`^${name} mode$`) })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await label.isVisible().catch(() => false)) return
      await page.locator('button').filter({ hasText: /^Standard mode$/ }).click()
      const item = page.getByRole('menuitem', { name: new RegExp(`^${name} mode`) })
      await expect(item).toBeVisible({ timeout: 10_000 })
      await item.evaluate(element => (element as HTMLElement).click())
      await page.waitForTimeout(300)
    }
    await expect(label).toBeVisible({ timeout: 20_000 })
  }

  test('selects PTC in the native surface and forwards it only on the first prompt', async () => {
    const page = host.page
    await dismissOverlays()
    await openBlank(/Playwright Remote · Alpha/)
    await expect(page.getByRole('button', { name: 'Select model' })).toBeVisible()
    await page.getByRole('button', { name: 'Select model' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByText('DeepSeek-V4-Pro', { exact: true }).click()
    await selectMode('PTC')
    expect(host.fake.createRequests).toHaveLength(0)

    const input = page.locator('textarea, [contenteditable="true"]').first()
    await expect(input).toBeVisible()
    await input.click()
    await input.fill('hello from playwright')
    await input.press('Enter')

    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(1)
    expect(host.fake.createRequests[0]?.agentPreset).toBe('ptc')
    await expect.poll(() => host.fake.promptRequests.length, { timeout: 20_000 }).toBe(1)
    expect(host.fake.promptRequests[0]?.provider).toBe('deepseek-official')
    expect(host.fake.promptRequests[0]?.model).toBe('deepseek-v4-pro')
  })

  test('resolves the current remote workspace for the global New Session action', async () => {
    const page = host.page
    const before = host.fake.createRequests.length
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-remote')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await page.getByRole('button', { name: /^New session$/ }).first().click()
    const response = await blankResponse
    expect(response.ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^Standard mode$/ })).toBeVisible({ timeout: 20_000 })
    expect(host.fake.createRequests).toHaveLength(before)
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('global new session prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('global new session prompt')
  })

  test('keeps remote creation lazy when a workspace New Session is clicked repeatedly', async () => {
    const page = host.page
    const before = host.fake.createRequests.length
    await dismissOverlays()
    await openBlank(/Playwright Remote · Alpha/)
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await workspace.hover()
    await page.getByRole('button', { name: /New session in .*Alpha/ }).click()
    await expect(page.locator('button').filter({ hasText: /^Standard mode$/ })).toBeVisible({ timeout: 20_000 })
    expect(host.fake.createRequests).toHaveLength(before)
  })


  test('keeps drafts isolated across two workspaces', async () => {
    const page = host.page
    await dismissOverlays()
    const before = host.fake.createRequests.length
    await openBlank(/Playwright Remote · Alpha/)
    await openBlank(/Playwright Remote · Beta/)
    expect(host.fake.createRequests).toHaveLength(before)
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('beta draft prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    expect(host.fake.createRequests.at(-1)?.workspaceId).toBe('workspace-beta')
    await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('beta draft prompt')
  })

  test('creates a remote workspace through the real UI dialog', async () => {
    const page = host.page
    await dismissOverlays()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: /New workspace|新建工作区/ })
    await expect(dialog).toBeVisible()
    await dialog.locator('.dshr-workspace-add-dialog-source-trigger').click()
    await page.locator('.dshr-workspace-add-dialog-destination-item').filter({ hasText: 'Playwright Remote' }).click()
    await dialog.locator('.dshr-workspace-add-dialog-add-folder').click()
    const folderDialog = page.getByRole('dialog', { name: /Choose a source folder|选择源目录/ })
    await expect(folderDialog).toBeVisible()
    await folderDialog.getByRole('button', { name: 'project' }).click()
    await folderDialog.getByRole('button', { name: /Use folder|使用此目录/ }).click()
    await dialog.locator('.dshr-workspace-add-dialog-input').fill('UIDebug')
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-remote')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 30_000 })
    const createResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-remote')
      && (response.request().postData() ?? '').includes('"endpoint":"host/workspace/create"'),
    { timeout: 30_000 })
    await dialog.locator('.dshr-workspace-add-dialog-button.dshr-workspace-add-dialog-primary').click()
    const created = await createResponse
    expect(created.ok()).toBeTruthy()
    const blank = await blankResponse
    expect(blank.ok()).toBeTruthy()
    await expect(page.getByRole('treeitem', { name: /Playwright Remote · UIDebug/ })).toBeVisible({ timeout: 30_000 })
  })

  test('removes a mirrored workspace through the native workspace delete flow', async () => {
    const page = host.page
    await dismissOverlays()
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-remote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'host/workspace/create', payload: { hostId: 'playwright-host', path: '/srv/delete-workspace', title: 'DeleteWorkspace' } }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · DeleteWorkspace/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    await page.getByRole('button', { name: 'Workspace actions for Playwright Remote · DeleteWorkspace' }).click()
    await page.getByRole('menuitem', { name: /Delete workspace|删除工作区/ }).click()
    const dialog = page.getByRole('dialog', { name: /Delete workspace|删除工作区/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /Delete workspace|删除工作区/ }).click()
    await expect(workspace).toHaveCount(0, { timeout: 30_000 })
  })

  test('keeps a local workspace New Session on the native path', async () => {
    const page = host.page
    await dismissOverlays()
    const workspace = page.getByRole('treeitem', { name: /Default workspace/ })
    await expect(workspace).toBeVisible({ timeout: 20_000 })
    const before = host.fake.createRequests.length
    let blankRequests = 0
    page.on('request', request => {
      if (request.url().includes('/api/dsh-remote') && (request.postData() ?? '').includes('"endpoint":"host/session/blank"')) blankRequests += 1
    })
    await workspace.hover()
    await page.getByRole('button', { name: /New session in .*Default workspace/ }).click()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(500)
    expect(blankRequests).toBe(0)
    expect(host.fake.createRequests).toHaveLength(before)
  })

  test('creates and opens a newly added remote workspace with the workspace + action', async () => {
    const page = host.page
    await dismissOverlays()
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-remote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'host/workspace/create',
          payload: { hostId: 'playwright-host', path: '/srv/new-created', title: 'NewCreated' },
        }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    const blankResponse = page.waitForResponse(response =>
      response.url().includes('/api/dsh-remote')
      && (response.request().postData() ?? '').includes('"endpoint":"host/session/blank"'),
    { timeout: 20_000 })
    await page.getByRole('button', { name: /New session in .*Alpha/ }).click()
    const response = await blankResponse
    expect(response.ok()).toBeTruthy()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
    const before = host.fake.createRequests.length
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('new workspace prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('new workspace prompt')
  })

  test('retries a failed native promotion without creating a second remote Session or running locally', async () => {
    const page = host.page
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-remote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'host/workspace/create',
          payload: { hostId: 'playwright-host', path: '/srv/retry-workspace', title: 'RetryWorkspace' },
        }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    await expect(page.getByRole('treeitem', { name: /Playwright Remote · RetryWorkspace/ })).toBeVisible({ timeout: 30_000 })
    const url = await host.restart()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await dismissOverlays()
    await page.getByRole('button', { name: 'Choose workspace' }).click()
    await page.getByRole('menuitem', { name: /Playwright Remote · RetryWorkspace/ }).click()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 30_000 })
    const beforeCreate = host.fake.createRequests.length
    const beforePrompts = host.fake.promptRequests.length
    host.fake.failPromptText = 'retry native prompt'
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('retry native prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(beforeCreate + 1)
    expect(host.fake.promptRequests).toHaveLength(beforePrompts)
    expect(host.fake.failPromptText).toBeUndefined()
    await input.fill('retry native prompt two')
    await input.press('Enter')
    await expect.poll(() => host.fake.promptRequests.length, { timeout: 20_000 }).toBe(beforePrompts + 1)
    expect(host.fake.promptRequests.at(-1)?.text).toBe('retry native prompt two')
    expect(host.fake.createRequests).toHaveLength(beforeCreate + 1)
  })

  test('keeps the workspace + action from creating a local blank when the host is disconnected', async () => {
    const page = host.page
    await dismissOverlays()
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    const disconnected = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-remote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'host/disconnect', payload: { hostId: 'playwright-host' } }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(disconnected.ok).toBe(true)
    expect(disconnected.body.ok).toBe(true)
    const before = host.fake.createRequests.length
    await workspace.hover()
    await page.getByRole('button', { name: /New session in .*Alpha/ }).click()
    await expect(page.getByText(/Could not create a session on the remote workspace|无法在远端工作区创建会话/)).toBeVisible({ timeout: 10_000 })
    expect(host.fake.createRequests).toHaveLength(before)
    const reconnected = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-remote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: 'host/connect', payload: { hostId: 'playwright-host' } }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(reconnected.ok).toBe(true)
    expect(reconnected.body.ok).toBe(true)
  })

  test('lets only one of two windows claim a promoted mirror', async () => {
    const page = host.page
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/dsh-remote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'host/workspace/create',
          payload: { hostId: 'playwright-host', path: '/srv/claim-workspace', title: 'ClaimWorkspace' },
        }),
      })
      return { ok: response.ok, body: await response.json() }
    })
    expect(created.ok).toBe(true)
    expect(created.body.ok).toBe(true)
    await expect(page.getByRole('treeitem', { name: /Playwright Remote · ClaimWorkspace/ })).toBeVisible({ timeout: 30_000 })
    const url = await host.restart()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await dismissOverlays()
    await page.getByRole('button', { name: 'Choose workspace' }).click()
    await page.getByRole('menuitem', { name: /Playwright Remote · ClaimWorkspace/ }).click()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 30_000 })

    const page2 = await host.browser.newPage()
    const claims: string[] = []
    for (const client of [page, page2]) {
      client.on('response', response => {
        if (!response.url().includes('/api/dsh-remote')) return
        const post = response.request().postData() ?? ''
        if (!post.includes('"endpoint":"host/session/open/claim"')) return
        void response.json().then((body: unknown) => {
          const value = body as { value?: { localSessionId?: string } }
          if (value.value?.localSessionId !== undefined) claims.push(value.value.localSessionId)
        }).catch(() => {})
      })
    }
    try {
      await page2.goto(url, { waitUntil: 'domcontentloaded' })
      await dismissOverlays()
      await expect(page2.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 30_000 })
      const before = host.fake.createRequests.length
      const input = page.locator('textarea, [contenteditable="true"]').first()
      await input.fill('two windows prompt')
      await input.press('Enter')
      await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
      await expect.poll(() => claims.length, { timeout: 20_000 }).toBe(1)
      await expect.poll(() => host.fake.promptRequests.at(-1)?.text, { timeout: 20_000 }).toBe('two windows prompt')
      expect(claims).toHaveLength(1)
    } finally {
      await page2.close()
    }
  })

  test('promotes a DSH-created native blank on its first prompt after a host restart', async () => {
    const page = host.page
    const url = await host.restart()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await dismissOverlays()
    await page.getByRole('button', { name: 'Choose workspace' }).click()
    await page.getByRole('menuitem', { name: /Playwright Remote · Beta/ }).click()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Select model' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByText('DeepSeek-V4.1-Flash', { exact: true }).click()
    await selectMode('PTC')
    const before = host.fake.createRequests.length
    const input = page.locator('textarea, [contenteditable="true"]').first()
    await input.fill('native restart prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(before + 1)
    expect(host.fake.createRequests.at(-1)?.agentPreset).toBe('ptc')
    await expect.poll(() => host.fake.promptRequests.length, { timeout: 20_000 }).toBeGreaterThan(0)
    expect(host.fake.promptRequests.at(-1)?.text).toBe('native restart prompt')
    expect(host.fake.promptRequests.at(-1)?.provider).toBe('deepseek-official')
    expect(host.fake.promptRequests.at(-1)?.model).toBe('deepseek-flash')
  })

})
