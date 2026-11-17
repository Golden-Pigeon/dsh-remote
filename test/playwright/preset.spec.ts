import { expect, test } from '@playwright/test'
import { appAvailable, startE2EHost, type E2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial' })

test.describe('remote agent preset scope', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')
  let host: E2EHost

  test.beforeAll(async () => {
    host = await startE2EHost({
      beforeStart: fake => {
        // The remote deployment declares fewer presets than the local one.
        fake.presets = [{ id: 'standard', name: 'Standard mode', isDefault: true }]
      },
    })
  })

  test.afterAll(async () => {
    await host?.close()
  })

  test('offers only presets the remote host advertises and forwards no other', async () => {
    const page = host.page
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 5_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Close' }).click({ timeout: 2_000 }).catch(() => {})
    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    await page.getByRole('button', { name: /New session in / }).click()

    const chip = page.locator('button').filter({ hasText: /^Standard mode$/ })
    await expect(chip).toBeVisible({ timeout: 20_000 })
    await chip.click()
    await expect(page.getByRole('menuitem', { name: /^Standard mode/ })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('menuitem', { name: /^PTC mode/ })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /^Minimal mode/ })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /^Creator mode/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Re-entering the same unsent remote blank re-mounts the chip; the menu
    // must still offer only the remote roster after the client re-attaches.
    await page.reload()
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 5_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Close' }).click({ timeout: 2_000 }).catch(() => {})
    const remounted = page.locator('button').filter({ hasText: /^Standard mode$/ })
    await expect(remounted).toBeVisible({ timeout: 20_000 })
    await remounted.click()
    await expect(page.getByRole('menuitem', { name: /^Standard mode/ })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('menuitem', { name: /^PTC mode/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const input = page.locator('textarea, [contenteditable="true"]').first()
    await expect(input).toBeVisible()
    await input.fill('preset scope prompt')
    await input.press('Enter')
    await expect.poll(() => host.fake.createRequests.length, { timeout: 20_000 }).toBe(1)
    // The only preset the remote advertises is also the one the Session starts on.
    expect(host.fake.createRequests[0]?.agentPreset).toBe('standard')
  })
})
