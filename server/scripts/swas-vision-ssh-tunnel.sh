#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 || $# -gt 4 ]]; then
  echo 'usage: swas-vision-ssh-tunnel.sh <worker-host> [key-file] [local-port] [remote-port]' >&2
  exit 2
fi

[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
worker_host="$1"
key_file="${2:-/opt/bobbo/secrets/vision-worker-tunnel-ed25519}"
local_port="${3:-3110}"
remote_port="${4:-3100}"
known_hosts='/opt/bobbo/secrets/vision-worker-known_hosts'
service_path='/etc/systemd/system/bobbo-vision-ssh-tunnel.service'

[[ "$worker_host" =~ ^([A-Za-z0-9.-]+|[0-9a-fA-F:]+)$ ]] || { echo 'invalid worker host' >&2; exit 2; }
[[ "$local_port" =~ ^[0-9]{2,5}$ && "$remote_port" =~ ^[0-9]{2,5}$ ]] || { echo 'invalid tunnel port' >&2; exit 2; }
key_file="$(realpath -- "$key_file")"
[[ "$key_file" == /opt/bobbo/secrets/* ]] || { echo 'refusing key outside /opt/bobbo/secrets' >&2; exit 1; }
[[ -s "$key_file" && -s "$known_hosts" ]] || { echo 'tunnel key or pinned known_hosts is missing' >&2; exit 1; }
[[ -x /usr/bin/ssh ]] || { echo '/usr/bin/ssh is unavailable' >&2; exit 1; }
chmod 0600 "$key_file" "$known_hosts"

cat >"$service_path" <<EOF
[Unit]
Description=BOBBO restricted tunnel to elastic vision worker
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/bin/ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${known_hosts} -i ${key_file} -L 127.0.0.1:${local_port}:127.0.0.1:${remote_port} root@${worker_host}
Restart=always
RestartSec=5
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadOnlyPaths=/opt/bobbo/secrets

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now bobbo-vision-ssh-tunnel.service
systemctl is-active --quiet bobbo-vision-ssh-tunnel.service
echo "VISION_SSH_TUNNEL_SERVICE_OK 127.0.0.1:${local_port}"
