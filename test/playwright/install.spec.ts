import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { appAvailable, installPlugin, PLUGIN_TARBALL, startE2EHost } from './dsh-fixture.ts'

test.describe.configure({ mode: 'serial', timeout: 300_000 })

interface Manifest {
  readonly version: string
  readonly engines?: { readonly dsh?: string }
  readonly dsh?: { readonly compatibility?: { readonly dsh?: string } }
}

interface ProfileManifest {
  readonly dependencies?: Record<string, string>
}

test.describe('plugin install and upgrade', () => {
  test.skip(!appAvailable(), 'requires the official DSH Desktop app and Chrome on macOS')

  test('replaces the registry 0.8.19 bundle with the rc.2 build', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-remote-dev-'))
    const devTarball = join(staging, `dsh-remote-local-plugin-0.8.19-dev-${Date.now()}.tgz`)
    copyFileSync(PLUGIN_TARBALL, devTarball)

    let oldManifest: Manifest | undefined
    const host = await startE2EHost({
      prepareHome: home => {
        installPlugin('web', 'dsh-remote-local-plugin@0.8.19', home)
        oldManifest = JSON.parse(readFileSync(join(home, 'profiles/web/node_modules/dsh-remote-local-plugin/package.json'), 'utf8')) as Manifest
      },
      pluginSpec: devTarball,
    })

    try {
      // The registry copy must really be the rc.1-built release, not the local one.
      expect(oldManifest?.version).toBe('0.8.19')
      expect(oldManifest?.dsh?.compatibility?.dsh).toBe('>=0.2.1-rc.1 <0.3.0-0')

      const profile = JSON.parse(readFileSync(join(host.home, 'profiles/web/package.json'), 'utf8')) as ProfileManifest
      expect(profile.dependencies?.['dsh-remote-local-plugin']).toContain('dsh-remote-local-plugin-0.8.19-dev-')

      const installed = JSON.parse(readFileSync(join(host.home, 'profiles/web/node_modules/dsh-remote-local-plugin/package.json'), 'utf8')) as Manifest
      expect(installed.engines?.dsh).toBe('>=0.2.2-rc.2 <0.3.0-0')

      const forkClient = join(host.home,
        'profiles/web/node_modules/dsh-remote-local-plugin/node_modules/dsh-remote-terminal-controller/lib/client.js')
      expect(existsSync(forkClient)).toBe(true)
      expect(readFileSync(forkClient, 'utf8')).toContain('watch(')

      const log = readFileSync(host.logPath, 'utf8')
      expect(log).not.toContain('disabling profile plugin')
      expect(log).not.toContain('is incompatible with dsh')

      // Open a mirrored session: rc.2 mounts AgentTerminalOpener on the header,
      // which calls ctx.webTerminals.watch. The old bundle would throw here.
      const page = host.page
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
      await page.getByRole('button', { name: 'Continue' }).click({ timeout: 5_000 }).catch(() => {})
      await page.getByRole('button', { name: 'Open sidebar' }).click({ timeout: 5_000 }).catch(() => {})
      const workspace = page.getByRole('treeitem', { name: /Playwright Remote · Alpha/ })
      await expect(workspace).toBeVisible({ timeout: 30_000 })
      await workspace.hover()
      await page.getByRole('button', { name: /New session in / }).click()
      await expect(page.locator('button').filter({ hasText: /^(Standard|PTC|Minimal|Creator) mode$/ })).toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(1_000)
      expect(pageErrors.filter(message => /webTerminals|is not a function|terminal.*watch/i.test(message))).toEqual([])
    } finally {
      await host.close()
      rmSync(staging, { recursive: true, force: true })
    }
  })
})
