#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/hby7921/openclaw-lingzhu.git}"
APP_DIR="${APP_DIR:-/opt/openclaw-lingzhu}"
PLUGIN_DIR="${PLUGIN_DIR:-$APP_DIR/skill/extension}"
OPENCLAW_CMD="${OPENCLAW_CMD:-openclaw}"
BRANCH="${BRANCH:-main}"

echo "[1/6] checking prerequisites"
command -v git >/dev/null 2>&1 || { echo "missing dependency: git"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "missing dependency: npm"; exit 1; }
command -v "$OPENCLAW_CMD" >/dev/null 2>&1 || { echo "missing command: $OPENCLAW_CMD"; exit 1; }

echo "[2/6] preparing repository in $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

echo "[3/6] installing plugin dependencies"
cd "$PLUGIN_DIR"
npm install

echo "[4/6] linking plugin into OpenClaw"
"$OPENCLAW_CMD" plugins install --link "$PLUGIN_DIR"

echo "[5/6] deployment files"
echo "config template: $APP_DIR/deploy/openclaw.lingzhu.config.json5"
echo "systemd template: $APP_DIR/deploy/openclaw-gateway.service.example"

echo "[6/6] next steps"
cat <<EOF
1. Merge the config template into your OpenClaw config.
2. Restart gateway:
   $OPENCLAW_CMD gateway restart
3. Verify:
   $OPENCLAW_CMD lingzhu info
   $OPENCLAW_CMD lingzhu status
   $OPENCLAW_CMD lingzhu capabilities
   $OPENCLAW_CMD lingzhu logpath
   curl http://127.0.0.1:18789/metis/agent/api/health

Lingzhu platform values:
- SSE URL: http://<your-public-ip>:18789/metis/agent/api/sse
- AK: run '$OPENCLAW_CMD lingzhu curl' and copy the Bearer token
EOF
