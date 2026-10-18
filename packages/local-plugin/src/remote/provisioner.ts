/**
 * Plugin-owned remote provisioning.
 *
 * On first connect the plugin uploads its bundled agent tarball, runs the
 * installer bootstrap script over SSH, then waits for the remote state file.
 * No separate installer command is required.
 *
 * @module dsh-remote-local/remote/provisioner
 */

import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { provisionRemoteAgent } from '@dsh-remote/installer'
import { isAgentLive } from '@dsh-remote/protocol'
import type { ResolvedConfig } from '../config.ts'
import { LocalError } from '../errors.ts'
import { discoverAgent } from '../ssh/probe.ts'
import type { ParsedSshTarget } from '../ssh/target.ts'

/** Progress callback shown in the host card. */
export type ProvisionProgress = (message: string) => void

/** Provisioner bound to one plugin config. */
export class RemoteProvisioner {
  readonly #config: ResolvedConfig

  constructor(config: ResolvedConfig) {
    this.#config = config
  }

  /**
   * Install/start the remote agent when discovery finds no live agent.
   *
   * @param target - validated SSH target.
   * @param options - optional local proxy endpoint and progress callback.
   */
  async ensureInstalled(
    target: ParsedSshTarget,
    options: {
      readonly modelBaseUrl?: string
      readonly modelApiKey?: string
      readonly onProgress?: ProvisionProgress
      readonly signal?: AbortSignal
    } = {},
  ): Promise<void> {
    const tarball = findAgentTarball()
    options.onProgress?.('正在远端安装 DSH 与 dsh-remote-agent（首次约 1–3 分钟）…')
    try {
      await provisionRemoteAgent({
        target: target.canonical,
        agentTarballPath: tarball,
        sshBinary: this.#config.sshBinary,
        strictHostKeyChecking: this.#config.strictHostKeyChecking,
        profile: 'web',
        installDir: this.#config.remoteInstallDir,
        dshHome: this.#config.remoteDshHome,
        dshVersion: this.#config.remoteDshVersion,
        pnpmVersion: this.#config.remotePnpmVersion,
        nodeVersion: this.#config.remoteNodeVersion,
        autoInstallNode: this.#config.autoInstallNode,
        start: this.#config.remoteStart,
        timeoutMs: this.#config.provisionTimeoutMs,
        ...options.modelBaseUrl === undefined ? {} : { modelBaseUrl: options.modelBaseUrl },
        ...options.modelApiKey === undefined ? {} : { modelApiKey: options.modelApiKey },
        verbose: false,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new LocalError('agent/unavailable', `远端自动安装失败：${detail}`, {
        details: { host: target.canonical },
        retryable: true,
        cause: error,
      })
    }

    options.onProgress?.('远端安装完成，等待 DSH web 启动…')
    await this.#waitForAgent(target, options.onProgress, options.signal)
  }

  async #waitForAgent(
    target: ParsedSshTarget,
    onProgress?: ProvisionProgress,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 120_000
    let lastError: unknown
    while (Date.now() < deadline) {
      if (signal?.aborted === true) throw new LocalError('internal', '远端安装已取消')
      try {
        const discovered = await discoverAgent(target, {
          sshBinary: this.#config.sshBinary,
          timeoutMs: this.#config.probeTimeoutMs,
          strictHostKeyChecking: this.#config.strictHostKeyChecking,
          remoteStateFile: this.#config.remoteStateFile,
        })
        if (isAgentLive(discovered.state)) return
      } catch (error) {
        lastError = error
        onProgress?.('等待远端 dsh web 就绪…')
      }
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    throw new LocalError('agent/unavailable', '远端 DSH web 未能在 120 秒内启动', {
      details: { host: target.canonical, reason: lastError instanceof Error ? lastError.message : String(lastError) },
      retryable: true,
    })
  }
}

/** Locate the packed agent shipped in this plugin's assets directory. */
export function findAgentTarball(): string {
  const candidates = [
    new URL('../assets', import.meta.url),
    new URL('../../assets', import.meta.url),
  ]
  for (const candidate of candidates) {
    const dir = fileURLToPath(candidate)
    if (!existsSync(dir)) continue
    const tarball = readdirSync(dir).find(name => name.endsWith('.tgz'))
    if (tarball !== undefined) return join(dir, tarball)
  }
  throw new LocalError(
    'internal',
    '本地插件没有内置 dsh-remote-agent 安装包；请重新执行 pnpm build 生成 assets',
  )
}
