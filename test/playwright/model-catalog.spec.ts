import { expect, test } from '@playwright/test'
import { appAvailable, startE2EHost, type E2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial' })

test.describe('mirrored Session model catalog', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')
  let host: E2EHost

  test.beforeAll(async () => { host = await startE2EHost() })
  test.afterAll(async () => { await host?.close() })

  test('shows only the remote model group and selects a remote model', async () => {
    const page = host.page
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 3_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 3_000 }).catch(() => {})

    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    await page.getByRole('button', { name: /New session in / }).click()
    await expect(page.locator('button').filter({ hasText: /^Standard mode$/ })).toBeVisible({ timeout: 20_000 })

    const trigger = page.getByRole('button', { name: 'Select model' })
    await trigger.click()
    const modelItem = page.getByRole('menuitem', { name: /^Model/ })
    await expect(modelItem).toBeVisible({ timeout: 10_000 })
    await modelItem.click()

    await expect(page.getByText('Remote · DeepSeek', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('DeepSeek', { exact: true })).toHaveCount(0)
    await expect(page.getByText('DeepSeek-V4-Pro', { exact: true })).toBeVisible()
    await page.getByText('DeepSeek-V4-Pro', { exact: true }).click()
    await expect(page.getByText('DeepSeek-V4-Pro', { exact: true })).toBeVisible({ timeout: 10_000 })
    expect(errors.filter(message => /directory\.load|is not a function/.test(message))).toEqual([])
  })
})
