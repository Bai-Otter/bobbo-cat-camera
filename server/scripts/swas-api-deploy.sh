#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'usage: swas-api-deploy.sh <source-tar.gz> [initial-runtime-tar.gz]' >&2
  exit 2
fi

[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
[[ "${BOBBO_OFFSITE_BACKUP_VERIFIED:-}" == '1' ]] || {
  echo 'refusing deployment until BOBBO_OFFSITE_BACKUP_VERIFIED=1' >&2
  exit 1
}

root='/opt/bobbo'
incoming_root="${root}/incoming"
release_root="${root}/releases"
data_root="${root}/data"
secret_root="${root}/secrets"
backup_root="${root}/backups"
source_tar="$(realpath -- "$1")"
runtime_tar=''
[[ -z "${2:-}" ]] || runtime_tar="$(realpath -- "$2")"

for candidate in "$source_tar" ${runtime_tar:+"$runtime_tar"}; do
  [[ "$candidate" == "$incoming_root/"* ]] || {
    echo "refusing archive outside ${incoming_root}: ${candidate}" >&2
    exit 1
  }
  [[ -s "$candidate" ]] || { echo "archive is missing or empty: ${candidate}" >&2; exit 1; }
done

node_bin="${BOBBO_NODE_BIN:-/opt/node-v22.18.0/bin/node}"
npm_bin="${BOBBO_NPM_BIN:-/opt/node-v22.18.0/bin/npm}"
[[ -x "$node_bin" ]] || { echo "Node 22 binary is unavailable: ${node_bin}" >&2; exit 1; }
[[ -x "$npm_bin" ]] || { echo "npm binary is unavailable: ${npm_bin}" >&2; exit 1; }
node_major="$($node_bin -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || { echo "Node 22 or newer is required, found $($node_bin --version)" >&2; exit 1; }
"$node_bin" -e 'require("node:sqlite")' >/dev/null || {
  echo "selected Node runtime cannot load node:sqlite: ${node_bin}" >&2
  exit 1
}
command -v curl >/dev/null
command -v tar >/dev/null
mkdir -p -- "$incoming_root" "$release_root" "$data_root" "$secret_root" "$backup_root"
chmod 0700 "$secret_root"

release_id="${BOBBO_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$release_id" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || { echo 'invalid BOBBO_RELEASE_ID' >&2; exit 2; }
release_dir="${release_root}/${release_id}"
[[ ! -e "$release_dir" ]] || { echo "release already exists: ${release_dir}" >&2; exit 1; }

previous_target=''
if [[ -L "${root}/current" ]]; then
  previous_target="$(readlink -f -- "${root}/current")"
  [[ "$previous_target" == "$release_root/"* ]] || {
    echo "refusing unexpected current target: ${previous_target}" >&2
    exit 1
  }
fi

cleanup_failed_release() {
  local resolved
  resolved="$(realpath -m -- "$release_dir")"
  if [[ ! -L "${root}/current" || "$(readlink -f -- "${root}/current")" != "$resolved" ]]; then
    [[ "$resolved" == "$release_root/"* ]] && rm -rf -- "$resolved"
  fi
}
trap cleanup_failed_release ERR

if find "$data_root" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  backup_dir="${backup_root}/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p -- "$backup_dir"
  tar -C "$root" -czf "${backup_dir}/data.tgz" data
  [[ ! -s "${secret_root}/app.env" ]] || install -m 0600 "${secret_root}/app.env" "${backup_dir}/app.env"
fi

mkdir -p -- "$release_dir"
tar -xzf "$source_tar" -C "$release_dir" --no-same-owner
[[ -f "${release_dir}/server/package-lock.json" ]] || { echo 'source archive lacks server/package-lock.json' >&2; exit 1; }
[[ -f "${release_dir}/server/src/server.js" ]] || { echo 'source archive lacks server/src/server.js' >&2; exit 1; }
"$npm_bin" --prefix "${release_dir}/server" ci --omit=dev --no-audit --no-fund

if [[ -n "$runtime_tar" ]] && ! find "$data_root" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  tar -xzf "$runtime_tar" -C / \
    --exclude='opt/bobbo/data/foodcast-temp' \
    --exclude='opt/bobbo/data/feed-analysis-test-temp' \
    --exclude='opt/bobbo/data/live-recording-temp'
fi

[[ -s "${secret_root}/app.env" ]] || { echo 'missing /opt/bobbo/secrets/app.env' >&2; exit 1; }
chmod 0600 "${secret_root}/app.env"
cat >"${secret_root}/runtime.env" <<'EOF'
NODE_ENV=production
HOST=127.0.0.1
PORT=3101
PUBLIC_BASE_URL=https://api.example.com
HTTP_BEHIND_PROXY=1
JF_DEVICE_REGISTRY_FILE=/opt/bobbo/data/devices.json
APP_DATA_STATE_FILE=/opt/bobbo/data/app-data.sqlite
ACCOUNT_SYNC_AUDIT_FILE=/opt/bobbo/data/account-sync-audit.jsonl
FEED_ANALYSIS_STATE_FILE=/opt/bobbo/data/feed-analysis-state.sqlite
FOODCAST_STATE_FILE=/opt/bobbo/data/foodcasts.sqlite
FOODCAST_OUTPUT_DIR=/opt/bobbo/data/foodcasts
FOODCAST_TEMP_DIR=/opt/bobbo/data/foodcast-temp
FOODCAST_MATERIAL_STATE_FILE=/opt/bobbo/data/foodcast-materials.sqlite
LIVE_RECORDING_STATE_FILE=/opt/bobbo/data/live-recordings.json
LIVE_RECORDING_TEMP_DIR=/opt/bobbo/data/live-recording-temp
LIVE_MEDIA_OUTPUT_DIR=/opt/bobbo/data/media
CAT_AVATAR_DIR=/opt/bobbo/data/media/cat-avatars
REPLAY_THUMBNAIL_DIR=/opt/bobbo/data/media/replay-thumbnails
DEVICE_COVER_DIR=/opt/bobbo/data/media/device-covers
EOF
chmod 0600 "${secret_root}/runtime.env"

cat >/etc/systemd/system/bobbo-backend.service <<'EOF'
[Unit]
Description=BOBBO mini-program API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/bobbo/current/server
EnvironmentFile=/opt/bobbo/secrets/app.env
EnvironmentFile=/opt/bobbo/secrets/runtime.env
ExecStart=/opt/node-v22.18.0/bin/node --max-old-space-size=512 src/server.js
Restart=always
RestartSec=5
TimeoutStartSec=90
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/bobbo/data
MemoryHigh=700M
MemoryMax=900M
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

ln -sfn -- "$release_dir" "${root}/current.next"
mv -Tf -- "${root}/current.next" "${root}/current"
systemctl daemon-reload
systemctl enable bobbo-backend.service
# `enable --now` only starts an inactive unit.  A running process keeps its old
# working directory after the `current` symlink changes, so every release must
# explicitly restart the service before the health gate.
systemctl restart bobbo-backend.service

healthy=0
for _attempt in $(seq 1 45); do
  if curl --silent --show-error --fail --max-time 3 http://127.0.0.1:3101/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" -ne 1 ]]; then
  if [[ -n "$previous_target" ]]; then
    ln -sfn -- "$previous_target" "${root}/current.next"
    mv -Tf -- "${root}/current.next" "${root}/current"
    systemctl restart bobbo-backend.service || true
  else
    systemctl stop bobbo-backend.service || true
  fi
  systemctl status bobbo-backend.service --no-pager >&2 || true
  exit 1
fi

mapfile -t backup_entries < <(find "$backup_root" -mindepth 1 -maxdepth 1 -printf '%T@|%p\n' | sort -t '|' -k1,1nr | cut -d '|' -f 2-)
for ((index=3; index<${#backup_entries[@]}; index++)); do
  candidate="$(realpath -m -- "${backup_entries[$index]}")"
  [[ "$candidate" == "$backup_root/"* ]] || { echo "refusing backup outside root: ${candidate}" >&2; exit 1; }
  rm -rf -- "$candidate"
done

trap - ERR
echo "SWAS_DEPLOY_OK ${release_id} http://127.0.0.1:3101/health"
