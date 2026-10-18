/**
 * Bootstrap script generation.
 *
 * The installer's contract with the remote machine is one POSIX bash script
 * on stdin. Rendering is pure and unit-tested; execution lives in
 * `commands.ts`. The script intentionally prints no token and never copies
 * model API keys.
 *
 * @module @dsh-remote/installer/bootstrap
 */

import type { InstallerOptions, StartMode } from './options.ts'

/** Options needed by the renderer. */
export interface BootstrapOptions {
  readonly profile: string
  readonly port: number
  readonly installDir: string
  readonly dshHome: string
  readonly dshVersion: string
  readonly pnpmVersion: string
  readonly nodeVersion: string
  readonly autoInstallNode: boolean
  readonly start: StartMode
  readonly agentTarball: string
  /** Remote DSH model endpoint; the local credential proxy URL when proxying. */
  readonly modelBaseUrl?: string
  /** Placeholder key for the local credential proxy; never the real key. */
  readonly modelApiKey?: string
  /** HTTP(S) proxy used by the remote installer. */
  readonly proxyUrl?: string
  /** Comma-separated proxy bypass list. */
  readonly noProxy?: string
}

/** Quote one shell literal. */
export function shellLiteral(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Render a path option, expanding a leading `~/` against the remote HOME. */
export function shellPath(value: string): string {
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) {
    const rest = value.slice(2)
    return `"$HOME/"${shellLiteral(rest)}`
  }
  if (value.startsWith('$HOME/')) {
    const rest = value.slice('$HOME/'.length)
    return `"$HOME/"${shellLiteral(rest)}`
  }
  return shellLiteral(value)
}

/** Render the private systemd user unit. */
export function renderSystemdUnit(options: BootstrapOptions): string {
  return [
    '[Unit]',
    'Description=DSH remote agent (DeepSeek Harness Web)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'Environment="DSH_HOME=$DSH_HOME"',
    // $PATH is expanded by the bootstrap shell after nodePathPrelude(), so the
    // systemd unit sees the discovered nvm/Volta/fnm Node bin directory too.
    'Environment="PATH=$INSTALL_DIR/node/bin:$INSTALL_DIR/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    ...options.modelBaseUrl === undefined ? [] : ['Environment="DEEPSEEK_BASE_URL=$MODEL_BASE_URL"'],
    ...options.modelApiKey === undefined ? [] : ['Environment="DEEPSEEK_API_KEY=$MODEL_API_KEY"'],
    'ExecStart="$DSH_BIN" web --host 127.0.0.1 --port $PORT --no-open',
    'Restart=always',
    'RestartSec=3',
    'WorkingDirectory=$DSH_HOME',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** Shell prelude that finds an existing non-interactive Node installation. */
export function nodePathPrelude(): string {
  return `if ! command -v node >/dev/null 2>&1; then
  for candidate in \\
    "$HOME/.volta/bin" \\
    "$HOME/.local/share/fnm" \\
    "$HOME/.bun/bin" \\
    "$HOME/.asdf/shims" \\
    "$HOME/.local/share/mise/shims" \\
    "$HOME/.nix-profile/bin" \\
    "$HOME/.n/bin" \\
    "$HOME/.local/bin" \\
    "/opt/homebrew/bin" \\
    "/usr/local/bin"; do
    if [ -d "$candidate" ]; then PATH="$candidate:$PATH"; fi
  done
  NODE_BIN_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  if [ -n "$NODE_BIN_DIR" ]; then PATH="$NODE_BIN_DIR:$PATH"; fi
  if ! command -v node >/dev/null 2>&1; then
    LOGIN_SHELL="\${SHELL:-}"
    if command -v getent >/dev/null 2>&1; then
      LOGIN_SHELL="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
    fi
    case "$LOGIN_SHELL" in
      */bash|*/zsh|*/sh|*/dash|*/ksh)
        NODE_BIN="$(env -i HOME="$HOME" PATH="$PATH" "$LOGIN_SHELL" -lc 'command -v node' 2>/dev/null | tail -n 1 || true)"
        if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then PATH="$(dirname "$NODE_BIN"):$PATH"; fi
        ;;
    esac
  fi
  export PATH
fi`
}

/** Shell function that installs the pinned official Node.js tarball without root. */
export function nodeInstallFunction(): string {
  return `install_node() {
  case "$(uname -s)" in
    Linux) NODE_OS=linux ;;
    Darwin) NODE_OS=darwin ;;
    *) echo "dsh-remote: unsupported OS for automatic Node.js install: $(uname -s)" >&2; return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    armv7l) NODE_ARCH=armv7l ;;
    *) echo "dsh-remote: unsupported architecture for automatic Node.js install: $(uname -m)" >&2; return 1 ;;
  esac

  NODE_INSTALL_ROOT="$INSTALL_DIR/node"
  NODE_DOWNLOAD="$INSTALL_DIR/.node-download.$$"
  NODE_ARCHIVE="node-v$NODE_VERSION-$NODE_OS-$NODE_ARCH.tar.gz"
  NODE_URL="https://nodejs.org/dist/v$NODE_VERSION"
  rm -rf "$NODE_DOWNLOAD"
  mkdir -p "$NODE_DOWNLOAD"
  echo "dsh-remote: downloading Node.js $NODE_VERSION ($NODE_OS-$NODE_ARCH)"
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL --retry 3 "$NODE_URL/SHASUMS256.txt" -o "$NODE_DOWNLOAD/SHASUMS256.txt" \\
      || ! curl -fsSL --retry 3 "$NODE_URL/$NODE_ARCHIVE" -o "$NODE_DOWNLOAD/$NODE_ARCHIVE"; then
      echo "dsh-remote: could not download Node.js from $NODE_URL" >&2
      rm -rf "$NODE_DOWNLOAD"
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget -q -O "$NODE_DOWNLOAD/SHASUMS256.txt" "$NODE_URL/SHASUMS256.txt" \\
      || ! wget -q -O "$NODE_DOWNLOAD/$NODE_ARCHIVE" "$NODE_URL/$NODE_ARCHIVE"; then
      echo "dsh-remote: could not download Node.js from $NODE_URL" >&2
      rm -rf "$NODE_DOWNLOAD"
      return 1
    fi
  else
    echo "dsh-remote: curl or wget is required to install Node.js automatically" >&2
    rm -rf "$NODE_DOWNLOAD"
    return 1
  fi

  EXPECTED="$(awk -v name="$NODE_ARCHIVE" '$2 == name { print $1; exit }' "$NODE_DOWNLOAD/SHASUMS256.txt")"
  if [ -z "$EXPECTED" ]; then
    echo "dsh-remote: Node.js checksum is missing from SHASUMS256.txt" >&2
    rm -rf "$NODE_DOWNLOAD"
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$NODE_DOWNLOAD/$NODE_ARCHIVE" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$NODE_DOWNLOAD/$NODE_ARCHIVE" | awk '{ print $1 }')"
  else
    echo "dsh-remote: sha256sum or shasum is required to verify Node.js" >&2
    rm -rf "$NODE_DOWNLOAD"
    return 1
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "dsh-remote: Node.js checksum mismatch" >&2
    rm -rf "$NODE_DOWNLOAD"
    return 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "dsh-remote: tar is required to install Node.js automatically" >&2
    rm -rf "$NODE_DOWNLOAD"
    return 1
  fi

  rm -rf "$NODE_INSTALL_ROOT"
  mkdir -p "$NODE_INSTALL_ROOT"
  if ! tar -xzf "$NODE_DOWNLOAD/$NODE_ARCHIVE" -C "$NODE_INSTALL_ROOT" --strip-components=1; then
    echo "dsh-remote: could not extract Node.js" >&2
    rm -rf "$NODE_DOWNLOAD" "$NODE_INSTALL_ROOT"
    return 1
  fi
  rm -rf "$NODE_DOWNLOAD"
  PATH="$NODE_INSTALL_ROOT/bin:$PATH"
  export PATH
  echo "dsh-remote: installed Node.js $NODE_VERSION at $NODE_INSTALL_ROOT"
}`
}

/** Render the complete bootstrap script. */
export function renderBootstrapScript(options: BootstrapOptions): string {
  const startBlock = renderStartBlock(options)
  return `#!/usr/bin/env bash
# dsh-remote installer bootstrap — generated, no secrets embedded.
set -euo pipefail

INSTALL_DIR=${shellPath(options.installDir)}
DSH_HOME=${shellPath(options.dshHome)}
PROFILE=${shellLiteral(options.profile)}
PORT=${shellLiteral(String(options.port))}
DSH_VERSION=${shellLiteral(options.dshVersion)}
PNPM_VERSION=${shellLiteral(options.pnpmVersion)}
NODE_VERSION=${shellLiteral(options.nodeVersion)}
AUTO_INSTALL_NODE=${options.autoInstallNode ? '1' : '0'}
AGENT_TARBALL=${shellLiteral(options.agentTarball)}
MODEL_BASE_URL=${options.modelBaseUrl === undefined ? "''" : shellLiteral(options.modelBaseUrl)}
MODEL_API_KEY=${options.modelApiKey === undefined ? "''" : shellLiteral(options.modelApiKey)}
PROXY_URL=${options.proxyUrl === undefined ? "''" : shellLiteral(options.proxyUrl)}
PROXY_NO_PROXY=${options.noProxy === undefined ? "''" : shellLiteral(options.noProxy)}
STATE_FILE="$DSH_HOME/remote-agent/agent.json"
WAIT_FOR_STATE=${options.start === 'none' ? 0 : 1}

export DSH_HOME
mkdir -p "$INSTALL_DIR" "$DSH_HOME/remote-agent"
echo "dsh-remote: preparing remote install"
if [ -z "$PROXY_URL" ]; then
  # Reuse a proxy already configured by the account's actual login shell.
  LOGIN_SHELL="\${SHELL:-}"
  if [ -z "$LOGIN_SHELL" ] || [ ! -x "$LOGIN_SHELL" ]; then
    if command -v getent >/dev/null 2>&1; then
      LOGIN_SHELL="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"
    else
      LOGIN_SHELL="$(awk -F: -v u="$(id -un)" '$1 == u { print $7; exit }' /etc/passwd)"
    fi
  fi
  if [ -z "$LOGIN_SHELL" ] || [ ! -x "$LOGIN_SHELL" ]; then
    LOGIN_SHELL=/bin/sh
  fi
  PROXY_TIMEOUT=""
  if command -v timeout >/dev/null 2>&1; then
    PROXY_TIMEOUT="timeout 5"
  fi
  read_proxy_env() {
    if [ -n "$PROXY_TIMEOUT" ]; then
      $PROXY_TIMEOUT "$LOGIN_SHELL" "$@" -c 'env' 2>/dev/null || true
    else
      "$LOGIN_SHELL" "$@" -c 'env' 2>/dev/null || true
    fi
  }
  proxy_from_env() {
    local proxy_value
    proxy_value="$(printf '%s\\n' "$1" | tr -d '\\r' | sed -n -e 's/^HTTPS_PROXY=//p' -e 's/^https_proxy=//p' | head -n 1)"
    if [ -z "$proxy_value" ]; then
      proxy_value="$(printf '%s\\n' "$1" | tr -d '\\r' | sed -n -e 's/^HTTP_PROXY=//p' -e 's/^http_proxy=//p' | head -n 1)"
    fi
    printf '%s' "$proxy_value"
  }
  PROXY_ENV="$(read_proxy_env -l -i)"
  PROXY_URL="$(proxy_from_env "$PROXY_ENV")"
  if [ -z "$PROXY_URL" ]; then
    PROXY_ENV="$(read_proxy_env -l)"
    PROXY_URL="$(proxy_from_env "$PROXY_ENV")"
  fi
  if [ -z "$PROXY_URL" ]; then
    PROXY_ENV="$(read_proxy_env -i)"
    PROXY_URL="$(proxy_from_env "$PROXY_ENV")"
  fi
fi
if [ -n "$PROXY_URL" ]; then
  export HTTP_PROXY="$PROXY_URL" http_proxy="$PROXY_URL"
  export HTTPS_PROXY="$PROXY_URL" https_proxy="$PROXY_URL"
  export ALL_PROXY="$PROXY_URL" all_proxy="$PROXY_URL"
  export npm_config_proxy="$PROXY_URL" npm_config_https_proxy="$PROXY_URL"
  if [ -n "$PROXY_NO_PROXY" ]; then
    export NO_PROXY="$PROXY_NO_PROXY" no_proxy="$PROXY_NO_PROXY"
  fi
  echo "dsh-remote: install proxy configured"
fi

${nodePathPrelude()}

${nodeInstallFunction()}
if ! command -v node >/dev/null 2>&1 \
  || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null 2>&1 \
  || ! command -v npm >/dev/null 2>&1; then
  if [ "$AUTO_INSTALL_NODE" -eq 1 ]; then
    install_node || exit 25
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "dsh-remote: Node.js is required but not on PATH; rerun with automatic Node.js installation enabled" >&2
  exit 21
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  echo "dsh-remote: Node.js 22.19+ is required (found $(node --version))" >&2
  exit 22
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "dsh-remote: npm is required; install a Node.js distribution that includes npm" >&2
  exit 23
fi
echo "dsh-remote: node ready"

export PATH="$INSTALL_DIR/node_modules/.bin:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "dsh-remote: installing pnpm@$PNPM_VERSION into $INSTALL_DIR"
  npm install --prefix "$INSTALL_DIR" --no-audit --no-fund "pnpm@$PNPM_VERSION"
fi

DSH_BIN="$INSTALL_DIR/node_modules/.bin/dsh"
if [ ! -x "$DSH_BIN" ]; then
  echo "dsh-remote: installing @deepseek-ai/dsh@$DSH_VERSION into $INSTALL_DIR"
  npm install --prefix "$INSTALL_DIR" --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION"
fi
if [ ! -x "$DSH_BIN" ]; then
  echo "dsh-remote: dsh installation did not produce $DSH_BIN" >&2
  exit 24
fi

echo "dsh-remote: adding plugin to profile $PROFILE"
"$DSH_BIN" plugin --profile "$PROFILE" add "$AGENT_TARBALL"

echo "dsh-remote: starting dsh web"
${startBlock}

if [ "$WAIT_FOR_STATE" -eq 1 ]; then
  echo "dsh-remote: waiting for agent state"
  i=0
  while [ "$i" -lt 60 ]; do
    if [ -s "$STATE_FILE" ]; then break; fi
    sleep 1
    i=$((i + 1))
  done
fi

echo "dsh-remote: installed"
echo "dsh-remote: state file $STATE_FILE"
if [ "$WAIT_FOR_STATE" -eq 1 ] && [ -s "$STATE_FILE" ]; then
  echo "dsh-remote: agent ready"
  PORT_VALUE=$(sed -n 's/.*"port": *\\([0-9][0-9]*\\).*/\\1/p' "$STATE_FILE" | head -1)
  echo "dsh-remote: remote agent port \${PORT_VALUE:-unknown}"
else
  echo "dsh-remote: warning: the agent state file is not ready yet; inspect the remote DSH log" >&2
fi
`
}

function renderStartBlock(options: BootstrapOptions): string {
  if (options.start === 'none') {
    return 'echo "dsh-remote: start mode none; start dsh web yourself"'
  }
  if (options.start === 'nohup') {
    return renderNohup(options)
  }
  const unit = renderSystemdUnit(options)
  return `UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
umask 077
cat > "$UNIT_DIR/dsh-remote-agent.service" <<DSH_REMOTE_UNIT
${unit}DSH_REMOTE_UNIT
chmod 600 "$UNIT_DIR/dsh-remote-agent.service"

echo "dsh-remote: restarting systemd user unit"
if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  if systemctl --user enable dsh-remote-agent.service >/dev/null 2>&1 \
    && systemctl --user restart dsh-remote-agent.service; then
    echo "dsh-remote: restarted systemd user unit dsh-remote-agent.service"
  else
    echo "dsh-remote: systemd user unit failed; falling back to nohup" >&2
    ${renderNohup(options)}
  fi
else
  echo "dsh-remote: systemd user manager unavailable; falling back to nohup" >&2
  ${renderNohup(options)}
fi`
}

function renderNohup(options: BootstrapOptions): string {
  const modelEnv = options.modelBaseUrl === undefined
    ? ''
    : `DEEPSEEK_BASE_URL="$MODEL_BASE_URL" DEEPSEEK_API_KEY="$MODEL_API_KEY" `
  return `if [ -f "$DSH_HOME/remote-agent/web.pid" ]; then
  kill "$(cat "$DSH_HOME/remote-agent/web.pid")" 2>/dev/null || true
fi
echo "dsh-remote: starting dsh web under nohup"
${modelEnv}nohup "$DSH_BIN" web --host 127.0.0.1 --port "$PORT" --no-open > "$DSH_HOME/remote-agent/web.log" 2>&1 &
echo $! > "$DSH_HOME/remote-agent/web.pid"
echo "dsh-remote: started dsh web under nohup (pid $(cat "$DSH_HOME/remote-agent/web.pid"))"`
}

/** Render from parsed CLI options; `agentTarball` must be the remote path. */
export function fromOptions(options: InstallerOptions, agentTarball: string): string {
  return renderBootstrapScript({
    profile: options.profile,
    port: options.port,
    installDir: options.installDir,
    dshHome: options.dshHome,
    dshVersion: options.dshVersion,
    pnpmVersion: options.pnpmVersion,
    nodeVersion: options.nodeVersion,
    autoInstallNode: options.autoInstallNode,
    start: options.start,
    agentTarball,
  })
}
