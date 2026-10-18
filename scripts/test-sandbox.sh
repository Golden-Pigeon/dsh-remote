#!/usr/bin/env bash
# Start an isolated DSH Web profile for integration/UI tests.
#
# This never touches ~/.dsh or the desktop profile. The temporary home is kept
# after the command so test results and mirrors can be inspected later.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${PROFILE:-web}"
TEST_HOME="${TEST_DSH_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-remote-test.XXXXXX")}"
case "$TEST_HOME" in
  "$HOME"|"$HOME/.dsh") echo "test-sandbox: refusing to use the primary DSH_HOME" >&2; exit 1 ;;
esac
export DSH_HOME="$TEST_HOME"
PORT="${PORT:-0}"

if [ -x /Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh ]; then
  DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
else
  DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
fi
if [ -z "$DSH_BIN" ] || [ ! -x "$DSH_BIN" ]; then
  echo "test-sandbox: set DSH_BIN to a DSH CLI executable" >&2
  exit 1
fi

cd "$ROOT"
pnpm install >/dev/null
pnpm -r build >/dev/null
cd "$ROOT/packages/local-plugin"
pnpm pack >/dev/null
TARBALL="$PWD/$(ls -t dsh-remote-local-plugin-*.tgz | head -1)"
cd "$ROOT/packages/terminal-controller"
pnpm pack >/dev/null
FORK="$PWD/$(ls -t dsh-remote-terminal-controller-*.tgz | head -1)"

"$DSH_BIN" plugin --profile "$PROFILE" add "$TARBALL" >/dev/null
"$DSH_BIN" plugin --profile "$PROFILE" add "$FORK" >/dev/null
# The standalone web shell needs the sidebar package outside the desktop app.
(cd "$DSH_HOME/profiles/$PROFILE" && pnpm add @deepseek-ai/dsh-client-ui-sidebar@0.2.1-rc.2 >/dev/null 2>&1 || true)

mkdir -p "$DSH_HOME/remote"
cat > "$DSH_HOME/remote/test-visibility.json" <<JSON
{
  "hiddenPaths": ["/tmp/dsh-remote-tests"],
  "hiddenWorkspaceIds": []
}
JSON

LOG="$DSH_HOME/test-sandbox.log"
DSH_HOME="$DSH_HOME" DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-test-sandbox-key}" \
  "$DSH_BIN" web --host 127.0.0.1 --port "$PORT" --no-open >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  URL=$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG" | tail -1 || true)
  if [ -n "${URL:-}" ]; then break; fi
  sleep 1
done
if [ -z "${URL:-}" ]; then
  echo "test-sandbox: server did not start; see $LOG" >&2
  kill "$PID" 2>/dev/null || true
  exit 1
fi
echo "test-sandbox: TEST_DSH_HOME=$TEST_HOME"
echo "test-sandbox: PID=$PID LOG=$LOG"
echo "test-sandbox: URL=$URL"
echo "test-sandbox: manifest=$DSH_HOME/remote/test-visibility.json"
echo "test-sandbox: this profile is isolated; do not use the production remote home."
