import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { startFakeHost, type FakeRemoteHost } from '@dsh-remote/testkit'

const ROOT = resolve(import.meta.dirname, '../..')
export const APP = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const FAKE_SSH = join(ROOT, 'test/playwright/fake-ssh.mjs')
const LOCAL_PLUGIN = JSON.parse(readFileSync(join(ROOT, 'packages/local-plugin/package.json'), 'utf8')) as { version: string }
export const PLUGIN_TARBALL = join(ROOT, `packages/local-plugin/dsh-remote-local-plugin-${LOCAL_PLUGIN.version}.tgz`)

export interface E2EHostOptions {
  /** Queue fake remote state before the local DSH host starts (e.g. approvals). */
  readonly beforeStart?: (fake: FakeRemoteHost) => void
  /** Prepare the isolated DSH home before the tested plugin is installed (e.g. install an older release). */
  readonly prepareHome?: (home: string) => void
  /** Plugin tarball or registry spec to install; defaults to the freshly built tarball. */
  readonly pluginSpec?: string
}

export interface E2EHost {
  readonly fake: FakeRemoteHost
  readonly home: string
  readonly url: string
  readonly child: ChildProcess
  readonly logPath: string
  readonly browser: Browser
  readonly page: Page
  readonly restart: () => Promise<string>
  readonly close: () => Promise<void>
}

export function installPlugin(profile: string, spec: string, home: string): void {
  execFileSync(APP, ['plugin', '--profile', profile, 'add', spec], {
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
    timeout: 180_000,
  })
}

function waitForUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let output = ''
    let error = ''
    const timer = setTimeout(() => reject(new Error(`DSH host did not start:\n${output}\n${error}`)), 60_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolveUrl(match[1]!)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString() })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`DSH host exited ${String(code)}\n${output}\n${error}`))
    })
  })
}

/** Start an isolated DSH web host wired to a fake remote agent through a fake ssh binary. */
export async function startE2EHost(options: E2EHostOptions = {}): Promise<E2EHost> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-playwright-'))
  options.prepareHome?.(home)
  const token = 'playwright-token-0123456789'
  const started = await startFakeHost({ hostId: 'playwright-host', token })
  const fake = started.host
  options.beforeStart?.(fake)
  const now = new Date().toISOString()
  const stateFile = join(home, 'fake-state.json')
  const fakeSshLog = join(home, 'fake-ssh.log')
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    token,
    port: started.port,
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    agentVersion: '0.2.12',
    dshVersion: '0.2.2-rc.2',
    url: `http://127.0.0.1:${started.port}`,
  }))
  chmodSync(FAKE_SSH, 0o755)
  installPlugin('web', options.pluginSpec ?? PLUGIN_TARBALL, home)
  installPlugin('web', '@deepseek-ai/dsh-workspace@0.2.2-rc.2', home)
  installPlugin('web', '@deepseek-ai/dsh-api-terminal-controller@0.2.2-rc.2', home)
  execFileSync('pnpm', ['add', join(ROOT, 'packages/terminal-controller')], {
    cwd: join(home, 'profiles', 'web'),
    env: { ...process.env, DSH_HOME: home },
    stdio: 'pipe',
    timeout: 180_000,
  })
  mkdirSync(join(home, 'remote'), { recursive: true })
  writeFileSync(join(home, 'remote', 'hosts.json'), JSON.stringify({
    version: 1,
    hosts: [{
      id: 'playwright-host',
      label: 'Playwright Remote',
      sshTarget: 'playwright-fake-host',
      sshPort: null,
      remoteAgentPort: started.port,
      token,
      autoConnect: true,
      createdAt: now,
      updatedAt: now,
    }],
  }, null, 2))
  writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: dsh-remote-local',
    '  config:',
    `    sshBinary: ${JSON.stringify(FAKE_SSH)}`,
    '    autoProvision: false',
    '- id: llm-deepseek',
    '  config:',
    '    models:',
    '      - id: deepseek-flash',
    '        name: DeepSeek-V4.1-Flash',
    '      - id: deepseek-v4-pro',
    '        name: DeepSeek-V4-Pro',
    '',
  ].join('\n'))
  const logPath = join(home, 'host.log')
  const logStream = createWriteStream(logPath)
  const startHost = (): ChildProcess => {
    const spawned = spawn(APP, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, DSH_REMOTE_FAKE_STATE: stateFile, DSH_REMOTE_FAKE_LOG: fakeSshLog, DEEPSEEK_API_KEY: 'playwright-test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    spawned.stdout?.pipe(logStream)
    spawned.stderr?.pipe(logStream)
    return spawned
  }
  let child = startHost()
  let browser: Browser | undefined
  try {
    const url = await waitForUrl(child)
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    return {
      fake,
      home,
      url,
      child,
      logPath,
      browser,
      page,
      async restart() {
        const previous = child
        previous.kill('SIGTERM')
        await new Promise(resolveExit => {
          if (previous.exitCode !== null) return resolveExit()
          previous.once('exit', resolveExit)
          setTimeout(resolveExit, 3_000)
        })
        child = startHost()
        return waitForUrl(child)
      },
      async close() {
        await browser?.close()
        child.kill('SIGTERM')
        await fake.stop()
        await new Promise(resolveClose => {
          if (child.exitCode !== null) return resolveClose()
          child.once('exit', resolveClose)
          setTimeout(resolveClose, 2_000)
        })
        rmSync(home, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await browser?.close().catch(() => {})
    child.kill('SIGKILL')
    await fake.stop().catch(() => {})
    throw error
  }
}

export function appAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(APP) && existsSync(CHROME) && existsSync(PLUGIN_TARBALL)
}
