import { expect, test } from '@playwright/test'
import { appAvailable, startE2EHost, type E2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial' })

test.describe('mirrored terminal', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')
  let host: E2EHost

  test.beforeAll(async () => { host = await startE2EHost() })
  test.afterAll(async () => { await host?.close() })

  test('opens a remote PTY and forwards keyboard input', async () => {
    const page = host.page
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5_000 }).catch(() => {})
    await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 5_000 }).catch(() => {})

    const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
    await expect(workspace).toBeVisible({ timeout: 30_000 })
    await workspace.hover()
    await page.getByRole('button', { name: /New session in / }).click()
    await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })

    const input = page.locator('textarea, [contenteditable="true"]').first()
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.click()
    await page.keyboard.press('Control+Backquote')
    const terminalTab = page.getByRole('tab', { name: 'Terminal' }).first()
    await expect(terminalTab).toBeVisible({ timeout: 10_000 })
    // The right sidebar can still be animating; dispatch the tab click directly.
    await terminalTab.evaluate(element => (element as HTMLElement).click())
    await page.waitForTimeout(2_000)
    await expect.poll(() => host.fake.terminalCreates.length, { timeout: 20_000 }).toBe(1)
    expect(host.fake.terminalCreates[0]?.shellPath).toBe('/bin/zsh')

    const terminal = page.locator('.xterm-helper-textarea').first()
    await expect(terminal).toBeAttached({ timeout: 20_000 })
    // xterm keeps its helper textarea hidden off-screen; focus it directly.
    await terminal.evaluate(element => (element as HTMLTextAreaElement).focus())
    await page.keyboard.type('echo hello')
    await page.keyboard.press('Enter')

    await expect.poll(
      () => host.fake.terminalInputs.filter(item => item.input.type === 'write').length,
      { timeout: 10_000 },
    ).toBeGreaterThan(0)
    expect(host.fake.terminalInputs.some(item => item.input.type === 'write' && item.input.data.includes('e'))).toBe(true)
    expect(errors.filter(message => /webTerminals|is not a function|terminal.*watch/i.test(message))).toEqual([])
  })
})
