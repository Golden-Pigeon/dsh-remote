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
    const version = /dsh-remote-agent-(.+)\.tgz$/u.exec(tarball)?.[1]
    const agentPackageSpec = version === undefined ? undefined : `@goldenpigeon/dsh-remote-agent@${version}`
    options.onProgress?.('正在准备远端安装环境…')
    const proxyUrl = this.#config.remoteInstallProxy.trim() || undefined
    if (proxyUrl !== undefined) options.onProgress?.('正在配置远端安装代理…')
    try {
      await provisionRemoteAgent({
        target: target.canonical,
        agentTarballPath: tarball,
        ...agentPackageSpec === undefined ? {} : { agentPackageSpec },
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
        ...proxyUrl === undefined ? {} : {
          proxyUrl,
          noProxy: this.#config.remoteInstallNoProxy,
        },
        onProgress: line => {
          const message = progressForLine(line)
          if (message !== undefined) options.onProgress?.(message)
        },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new LocalError('agent/unavailable', `远端自动安装失败：${detail}`, {
        details: { host: target.canonical },
        retryable: true,
        cause: error,
      })
    }

    options.onProgress?.('远端安装完成，正在等待 DSH web 启动…')
    await this.#waitForAgent(target, options.onProgress, options.signal)
  }

  async #waitForAgent(
    target: ParsedSshTarget,
    onProgress?: ProvisionProgress,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 120_000
    let lastError: unknown
    onProgress?.('正在等待远端 agent 状态…')
    while (Date.now() < deadline) {
      if (signal?.aborted === true) throw new LocalError('internal', '远端安装已取消')
      try {
        const discovered = await discoverAgent(target, {
          sshBinary: this.#config.sshBinary,
          timeoutMs: this.#config.probeTimeoutMs,
          strictHostKeyChecking: this.#config.strictHostKeyChecking,
          remoteStateFile: this.#config.remoteStateFile,
        })
        if (isAgentLive(discovered.state)) {
          onProgress?.('远端 agent 已就绪，正在建立连接…')
          return
        }
      } catch (error) {
        lastError = error
        onProgress?.('仍在等待远端 dsh web 就绪…')
      }
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    throw new LocalError('agent/unavailable', '远端 DSH web 未能在 120 秒内启动', {
      details: { host: target.canonical, reason: lastError instanceof Error ? lastError.message : String(lastError) },
      retryable: true,
    })
  }
}

const PROVISION_PROGRESS: readonly (readonly [string, string])[] = [
  ['uploading agent package', '正在上传远端 agent 安装包…'],
  ['agent package uploaded', '安装包上传完成，开始远端安装…'],
  ['preparing remote install', '正在准备远端安装环境…'],
  ['install proxy configured', '已配置远端安装代理…'],
  ['downloading node.js', '正在下载 Node.js…'],
  ['installed node.js', 'Node.js 安装完成，继续安装 pnpm/DSH…'],
  ['node ready', 'Node.js 已就绪，准备安装 pnpm/DSH…'],
  ['installing pnpm@', '正在安装 pnpm…'],
  ['installing @deepseek-ai/dsh@', '正在安装远端 DSH（下载依赖可能需要几分钟）…'],
  ['adding plugin to profile', '正在安装远端 agent…'],
  ['restarting systemd user unit', '正在启动远端 DSH Web 服务…'],
  ['starting dsh web under nohup', '正在启动远端 DSH Web…'],
  ['starting dsh web', '正在启动远端 DSH Web 服务…'],
  ['waiting for agent state', '正在等待远端 agent 状态文件…'],
  ['agent ready', '远端 agent 已就绪，正在建立连接…'],
  ['installed', '远端安装完成…'],
]

function progressForLine(line: string): string | undefined {
  const normalized = line.toLowerCase()
  for (const [needle, message] of PROVISION_PROGRESS) {
    if (normalized.includes(needle)) return message
  }
  return undefined
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
