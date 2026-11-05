import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    await blankResponse
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
    await page.getByRole('button', { name: /^New session$/ }).first().click()
    await expect(page.locator('button').filter({ hasText: /^Standard mode$/ })).toBeVisible({ timeout: 20_000 })
    expect(host.fake.createRequests).toHaveLength(before)
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


  test('persists a pending blank remote Session across a DSH host restart', async () => {
    const page = host.page
    const before = host.fake.createRequests.length
    await dismissOverlays()
    await openBlank(/Playwright Remote · Alpha/)

    const pendingState = async (): Promise<Array<Record<string, unknown>>> => {
      const file = JSON.parse(await readFile(join(host.home, 'remote', 'mirrors.json'), 'utf8')) as {
        pendingBlanks?: Record<string, Record<string, unknown>>
      }
      return Object.values(file.pendingBlanks ?? {})
    }
    expect((await pendingState()).length).toBeGreaterThan(0)
    const url = await host.restart()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await dismissOverlays()
    expect((await pendingState()).length).toBeGreaterThan(0)
    expect(host.fake.createRequests).toHaveLength(before)
  })

})
