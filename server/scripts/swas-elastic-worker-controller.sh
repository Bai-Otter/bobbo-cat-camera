#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo 'usage: swas-elastic-worker-controller.sh <controller-js> <budget-js> <env-file>' >&2
  exit 2
fi

[[ "$(id -u)" -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }
controller_source="$(realpath -- "$1")"
budget_source="$(realpath -- "$2")"
env_source="$(realpath -- "$3")"
for candidate in "$controller_source" "$budget_source"; do
  [[ "$candidate" == /opt/bobbo/incoming/* && -s "$candidate" ]] || {
    echo "refusing source outside /opt/bobbo/incoming: $candidate" >&2
    exit 1
  }
done
[[ "$env_source" == /opt/bobbo/secrets/* && -s "$env_source" ]] || {
  echo 'controller environment must be a non-empty file under /opt/bobbo/secrets' >&2
  exit 1
}
[[ -x /opt/node-v22.18.0/bin/node ]] || { echo 'Node 22 is unavailable' >&2; exit 1; }
command -v aliyun >/dev/null

install -d -m 0755 /opt/bobbo/bin /opt/bobbo/src/feedAnalysis /opt/bobbo/elastic-worker
install -m 0755 "$controller_source" /opt/bobbo/bin/elastic-vision-worker-controller.js
install -m 0644 "$budget_source" /opt/bobbo/src/feedAnalysis/elasticWorkerBudget.js
chmod 0600 "$env_source"

cat >/etc/systemd/system/bobbo-elastic-vision-controller.service <<EOF
[Unit]
Description=BOBBO elastic vision worker controller
After=network-online.target bobbo-backend.service bobbo-vision-ssh-tunnel.service
Wants=network-online.target bobbo-backend.service bobbo-vision-ssh-tunnel.service

[Service]
Type=simple
WorkingDirectory=/opt/bobbo
Environment=HOME=/root
EnvironmentFile=${env_source}
ExecStart=/opt/node-v22.18.0/bin/node /opt/bobbo/bin/elastic-vision-worker-controller.js
Restart=always
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/bobbo/elastic-worker
MemoryMax=160M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bobbo-elastic-vision-controller.service
systemctl restart bobbo-elastic-vision-controller.service
systemctl is-active --quiet bobbo-elastic-vision-controller.service
echo 'ELASTIC_VISION_CONTROLLER_SERVICE_OK'
