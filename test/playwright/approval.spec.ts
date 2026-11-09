import { expect, test, type Page } from '@playwright/test'

import { appAvailable, startE2EHost, type E2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial' })

async function dismissOverlays(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 2_000 }).catch(() => {})
  await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 2_000 }).catch(() => {})
}

async function openMirroredSession(page: Page): Promise<void> {
  const workspace = page.getByRole('treeitem', { name: /Playwright Remote · \/tmp/ })
  await expect(workspace).toBeVisible({ timeout: 30_000 })
  await workspace.click()
  const session = page.getByRole('treeitem', { name: /Untitled/ }).first()
  await expect(session).toBeVisible({ timeout: 15_000 })
  await session.click()
}

test.describe('mirrored approval across two clients', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')
  let host: E2EHost
  let second: Page

  test.beforeAll(async () => {
    host = await startE2EHost({
      beforeStart: fake => fake.requestApproval({
        id: 'e2e-approval',
        sessionId: 'session-gamma',
        toolName: 'write',
        reason: 'E2E approval test',
      }),
    })
    second = await host.browser.newPage()
    await second.goto(host.url, { waitUntil: 'domcontentloaded' })
  })

  test.afterAll(async () => {
    await second?.close()
    await host?.close()
  })

  test('one client answers and the other client dismisses the approval', async () => {
    await dismissOverlays(host.page)
    await dismissOverlays(second)
    // The approval arrives before any client shows the mirrored Session. It
    // must wait instead of being answered unavailable.
    expect(host.fake.approvalAnswers).toEqual([])
    await openMirroredSession(host.page)
    await openMirroredSession(second)

    const firstAllow = host.page.getByRole('button', { name: 'Allow once' })
    const secondAllow = second.getByRole('button', { name: 'Allow once' })
    await expect(host.page.getByText('Waiting for approval').first()).toBeVisible({ timeout: 30_000 })
    await expect(second.getByText('Waiting for approval').first()).toBeVisible({ timeout: 30_000 })
    await expect(firstAllow).toBeVisible({ timeout: 30_000 })
    await expect(secondAllow).toBeVisible({ timeout: 30_000 })

    await firstAllow.click()

    await expect(firstAllow).toHaveCount(0, { timeout: 15_000 })
    await expect(secondAllow).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => host.fake.approvalAnswers, { timeout: 15_000 }).toEqual([
      { id: 'e2e-approval', outcome: 'allowed-once' },
    ])
  })
})
