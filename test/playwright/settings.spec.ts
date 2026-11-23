import { expect, test } from '@playwright/test'
import { appAvailable, startE2EHost, type E2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial' })

test.describe('remote settings UI', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')
  let host: E2EHost

  test.beforeAll(async () => {
    host = await startE2EHost({ isolateSshConfig: true })
  })
  test.afterAll(async () => { await host?.close() })

  async function openRemoteSettings(): Promise<void> {
    const page = host.page
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3_000 }).catch(() => {})
    await page.locator('button[aria-label="Account menu"]').click({ timeout: 15_000 })
    await page.getByText(/^Settings$|^设置$/).first().click({ timeout: 10_000 })
    await page.getByText(/Remote development|远程开发/).first().click({ timeout: 10_000 })
    await expect(page.locator('#dshr-ssh-target-input')).toBeVisible({ timeout: 20_000 })
  }

  test('suggests isolated SSH config aliases and contains Escape in the SSH field', async () => {
    const page = host.page
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await openRemoteSettings()

    const input = page.locator('#dshr-ssh-target-input')
    const options = page.locator('.dshr-ssh-option')
    await expect(options).toHaveCount(0)

    await input.focus()
    await expect(options.filter({ hasText: 'fixture-alias' })).toBeVisible()
    await expect(page.locator('#dshr-ssh-suggestions')).toBeVisible()

    const scrollBefore = await page.evaluate(() => window.scrollY)
    await input.focus()
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore)

    await page.keyboard.press('Escape')
    await expect(options).toHaveCount(0)
    await expect(input).toBeVisible()
    await expect(page.getByText(/Remote development|远程开发/).first()).toBeVisible()

    await input.click()
    await expect(options.filter({ hasText: 'fixture-alias' })).toBeVisible()
    await options.filter({ hasText: 'fixture-alias' }).click()
    await expect(input).toHaveValue('fixture-alias')
    await expect(options).toHaveCount(0)

    await input.fill('ssh -p 2222 -i ~/.ssh/key example-host')
    await expect(input).toHaveValue('ssh -p 2222 -i ~/.ssh/key example-host')
    expect(errors).toEqual([])
  })

  test('keeps host cards compact and expands only the model settings', async () => {
    const page = host.page
    await openRemoteSettings()
    const summary = page.locator('.dshr-host-summary').first()
    await expect(summary).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.dshr-host-body')).toHaveCount(0)
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(await page.locator('.dshr-actions button').count()).toBeGreaterThan(0)

    await summary.click()
    await expect(page.locator('.dshr-host-body')).toHaveCount(1)
    await expect(page.locator('.dshr-model-settings').first()).toBeVisible()
    await expect(summary).toHaveAttribute('aria-expanded', 'true')

    await summary.click()
    await expect(page.locator('.dshr-host-body')).toHaveCount(0)
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
  })
})
