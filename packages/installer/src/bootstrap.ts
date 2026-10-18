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
  readonly start: StartMode
  readonly agentTarball: string
  /** Remote DSH model endpoint; the local credential proxy URL when proxying. */
  readonly modelBaseUrl?: string
  /** Placeholder key for the local credential proxy; never the real key. */
  readonly modelApiKey?: string
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
    'Environment="PATH=$INSTALL_DIR/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
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

/** Shell prelude that finds a non-interactive Node installation (nvm, Volta, fnm, Bun). */
export function nodePathPrelude(): string {
  return `if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME/.volta/bin" "$HOME/.local/share/fnm" "$HOME/.bun/bin"; do
    if [ -d "$candidate" ]; then PATH="$candidate:$PATH"; fi
  done
  NODE_BIN_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  if [ -n "$NODE_BIN_DIR" ]; then PATH="$NODE_BIN_DIR:$PATH"; fi
  export PATH
fi`
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
AGENT_TARBALL=${shellLiteral(options.agentTarball)}
MODEL_BASE_URL=${options.modelBaseUrl === undefined ? "''" : shellLiteral(options.modelBaseUrl)}
MODEL_API_KEY=${options.modelApiKey === undefined ? "''" : shellLiteral(options.modelApiKey)}
STATE_FILE="$DSH_HOME/remote-agent/agent.json"
WAIT_FOR_STATE=${options.start === 'none' ? 0 : 1}

export DSH_HOME
mkdir -p "$INSTALL_DIR" "$DSH_HOME/remote-agent"

${nodePathPrelude()}

if ! command -v node >/dev/null 2>&1; then
  echo "dsh-remote: Node.js is required but not on PATH" >&2
  exit 21
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  echo "dsh-remote: Node.js 22.19+ is required (found $(node --version))" >&2
  exit 22
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "dsh-remote: npm is required but not on PATH" >&2
  exit 23
fi

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

${startBlock}

if [ "$WAIT_FOR_STATE" -eq 1 ]; then
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
cat > "$UNIT_DIR/dsh-remote-agent.service" <<DSH_REMOTE_UNIT
${unit}DSH_REMOTE_UNIT

if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  if systemctl --user enable --now dsh-remote-agent.service; then
    echo "dsh-remote: started systemd user unit dsh-remote-agent.service"
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
    start: options.start,
    agentTarball,
  })
}
