/**
 * Plugin-owned user settings.
 *
 * The installed plugin is a bundle: its default `copyModelKey` and
 * `credentialProxy` live in the bundle patch, not in a profile row the settings
 * UI can edit. This store keeps the user's explicit choices in the plugin state
 * directory and uses the config values only as defaults. It contains no secrets.
 *
 * @module dsh-remote-local/settings
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Settings resolved for the running host service. */
export interface EffectiveSettings {
  /** Copy the locally resolved model key into the remote service env. */
  readonly copyModelKey: boolean
  /** Use the local credential proxy instead of a direct remote key. */
  readonly credentialProxy: boolean
}

/** Persistent override of the bundle's settings defaults. */
export class SettingsStore {
  readonly #path: string
  readonly #defaults: EffectiveSettings

  constructor(path: string, defaults: EffectiveSettings) {
    this.#path = path
    this.#defaults = defaults
  }

  /** File backing the user's settings, for diagnostics. */
  get path(): string { return this.#path }

  /**
   * Read the stored settings, falling back to the bundle defaults.
   *
   * Synchronous on purpose: the plugin must install mirror ownership before
   * its first await, and a settings read must not add one to startup.
   */
  load(): EffectiveSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as {
        copyModelKey?: unknown
        credentialProxy?: unknown
      }
      return {
        copyModelKey: typeof parsed.copyModelKey === 'boolean'
          ? parsed.copyModelKey
          : this.#defaults.copyModelKey,
        credentialProxy: typeof parsed.credentialProxy === 'boolean'
          ? parsed.credentialProxy
          : this.#defaults.credentialProxy,
      }
    } catch {
      // Missing, unreadable, or malformed: the bundle default is the safe value.
      return this.#defaults
    }
  }

  /** Persist one setting atomically. */
  async setCopyModelKey(copyModelKey: boolean): Promise<void> {
    await this.#write({ ...(await this.load()), copyModelKey })
  }

  /** Persist the global proxy mode atomically. */
  async setCredentialProxy(credentialProxy: boolean): Promise<void> {
    await this.#write({ ...(await this.load()), credentialProxy })
  }

  async #write(settings: EffectiveSettings): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.#path)
  }
}
