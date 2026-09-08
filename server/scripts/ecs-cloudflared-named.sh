#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo 'usage: ecs-cloudflared-named.sh <public-hostname> [token-file] [origin-url]' >&2
  exit 2
fi

public_hostname="$1"
token_file="${2:-/opt/bobbo/secrets/cloudflared-named-token}"
origin_url="${3:-http://127.0.0.1:3000}"
primary_service='bobbo-cloudflared-named.service'
replica_service='bobbo-cloudflared-named-replica.service'

[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
[[ "$public_hostname" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || {
  echo 'invalid public hostname' >&2
  exit 2
}
[[ "$origin_url" =~ ^http://127\.0\.0\.1:[0-9]{2,5}$ ]] || {
  echo 'origin URL must be an HTTP loopback address with an explicit port' >&2
  exit 2
}
[[ -f "$token_file" && -s "$token_file" ]] || {
  echo "tunnel token file is missing or empty: $token_file" >&2
  exit 1
}

token_file="$(realpath -- "$token_file")"
[[ "$token_file" == /opt/bobbo/secrets/* ]] || {
  echo "refusing token file outside /opt/bobbo/secrets: $token_file" >&2
  exit 1
}
[[ -x /usr/bin/cloudflared ]] || { echo '/usr/bin/cloudflared is unavailable' >&2; exit 1; }
curl --silent --show-error --fail --max-time 5 "${origin_url}/health" >/dev/null
chmod 0600 "$token_file"

temporary_unit="$(mktemp /etc/systemd/system/.bobbo-cloudflared-named.XXXXXX)"
cleanup() {
  local resolved
  resolved="$(realpath -m -- "$temporary_unit")"
  if [[ "$resolved" == /etc/systemd/system/.bobbo-cloudflared-named.* ]]; then
    rm -f -- "$resolved"
  fi
}
trap cleanup EXIT

write_unit() {
  local service_path="$1"
  local description="$2"
  local protocol="$3"
  cat >"$temporary_unit" <<EOF
[Unit]
Description=${description} (${public_hostname})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStartPre=/usr/bin/curl --silent --show-error --fail --max-time 5 ${origin_url}/health
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --protocol ${protocol} run --token-file ${token_file}
Restart=always
RestartSec=2
TimeoutStartSec=60
TimeoutStopSec=30
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  install -m 0644 "$temporary_unit" "$service_path"
}

write_unit "/etc/systemd/system/${primary_service}" "BOBBO permanent Cloudflare Named Tunnel HTTP/2 connector" 'http2'
write_unit "/etc/systemd/system/${replica_service}" "BOBBO permanent Cloudflare Named Tunnel QUIC connector" 'quic'
systemctl daemon-reload
systemctl enable "$primary_service" "$replica_service"
systemctl restart "$primary_service" "$replica_service"

for _attempt in $(seq 1 30); do
  if systemctl is-active --quiet "$primary_service" && systemctl is-active --quiet "$replica_service"; then
    echo "NAMED_TUNNEL_SERVICES_OK https://${public_hostname}"
    exit 0
  fi
  sleep 1
done

systemctl status "$primary_service" "$replica_service" --no-pager >&2 || true
exit 1
