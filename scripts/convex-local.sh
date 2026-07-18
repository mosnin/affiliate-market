#!/usr/bin/env bash
# Local Convex backend harness — verifiable Convex dev with NO cloud account.
#
# Stands up the open-source convex-local-backend (sqlite-backed) so we can push
# schema, run functions, and codegen entirely offline. This is the verification
# oracle for the Supabase -> Convex migration: every Convex function is pushed
# and run against this before it's trusted, the same way the Postgres+PostgREST
# harness backed the original build.
#
#   bash scripts/convex-local.sh up      # download (if needed) + start backend
#   bash scripts/convex-local.sh env     # print the CLI env file path
#   bash scripts/convex-local.sh push    # convex dev --once (push schema + codegen)
#   bash scripts/convex-local.sh down     # stop the backend
#
# Env file written to /tmp/cvx-cli.env:  CONVEX_SELF_HOSTED_URL + ADMIN_KEY.
# Push/run with:  npx convex dev --once --env-file /tmp/cvx-cli.env
set -euo pipefail

CVX_DIR=/tmp/cvx
BIN="$CVX_DIR/convex-local-backend"
CREDS=/tmp/cvx-creds.env
CLI_ENV=/tmp/cvx-cli.env
INSTANCE=cola-local
PORT=3210
URL="http://127.0.0.1:$PORT"
ASSET="convex-local-backend-x86_64-unknown-linux-gnu.zip"

ensure_binary() {
  if [[ ! -x "$BIN" ]]; then
    mkdir -p "$CVX_DIR"
    curl -fsSL "https://github.com/get-convex/convex-backend/releases/latest/download/$ASSET" -o "$CVX_DIR/cvx.zip"
    unzip -o "$CVX_DIR/cvx.zip" -d "$CVX_DIR" >/dev/null
    chmod +x "$BIN"
  fi
}

ensure_creds() {
  if [[ ! -f "$CREDS" ]]; then
    local secret admin
    secret=$(openssl rand -hex 32)
    admin=$("$BIN" keygen admin-key --instance-name "$INSTANCE" --instance-secret "$secret")
    printf 'SECRET=%s\nADMIN_KEY=%s\n' "$secret" "$admin" > "$CREDS"
  fi
  # shellcheck disable=SC1090
  source "$CREDS"
  printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$URL" "$ADMIN_KEY" > "$CLI_ENV"
}

case "${1:-up}" in
  up)
    ensure_binary; ensure_creds
    if curl -fsS "$URL/version" >/dev/null 2>&1; then echo "already up at $URL"; exit 0; fi
    source "$CREDS"
    nohup "$BIN" --instance-name "$INSTANCE" --instance-secret "$SECRET" \
      --port "$PORT" --site-proxy-port 3211 --disable-beacon \
      --local-storage "$CVX_DIR/storage" "$CVX_DIR/cola.sqlite3" \
      > "$CVX_DIR/backend.log" 2>&1 &
    for _ in $(seq 1 20); do curl -fsS "$URL/version" >/dev/null 2>&1 && { echo "up at $URL"; exit 0; }; sleep 1; done
    echo "backend failed to come up; see $CVX_DIR/backend.log" >&2; exit 1
    ;;
  env) ensure_creds; echo "$CLI_ENV" ;;
  push) ensure_creds; npx convex dev --once --env-file "$CLI_ENV" "${@:2}" ;;
  down) pkill -f convex-local-backend || true; echo "stopped" ;;
  *) echo "usage: $0 {up|env|push|down}" >&2; exit 1 ;;
esac
