#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
  echo 'usage: ecs-deploy.sh <release-tag> <source-tar> <initial-data-tar-or-> <env-file>' >&2
  exit 2
fi
if [[ "${BOBBO_OFFSITE_BACKUP_VERIFIED:-0}" != '1' ]]; then
  echo 'refusing deploy: set BOBBO_OFFSITE_BACKUP_VERIFIED=1 after verifying the encrypted off-server snapshot' >&2
  exit 1
fi

release_tag="$1"
source_tar="$(realpath -- "$2")"
initial_data_tar="$3"
env_file="$(realpath -- "$4")"
[[ "$release_tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'invalid release tag' >&2; exit 2; }
[[ -f "$source_tar" ]] || { echo 'source archive not found' >&2; exit 1; }
[[ -f "$env_file" ]] || { echo 'environment file not found' >&2; exit 1; }

install -d -m 0755 /opt/bobbo/data /opt/bobbo/logs /opt/bobbo/backups /opt/bobbo/bin
install -d -m 0700 /opt/bobbo/secrets
build_dir="$(mktemp -d /opt/bobbo/build.XXXXXX)"
rollback_name="bobbo-backend-rollback-${release_tag}"
image="bobbo-backend:${release_tag}"
backend_paused=0

resume_backend() {
  if [[ "$backend_paused" -eq 1 ]]; then
    docker unpause bobbo-backend >/dev/null
    backend_paused=0
  fi
}

cleanup() {
  local resolved
  resume_backend
  resolved="$(realpath -m -- "$build_dir")"
  if [[ "$resolved" == /opt/bobbo/build.* ]]; then
    rm -rf -- "$resolved"
  else
    echo "refusing cleanup of unexpected build path: $resolved" >&2
  fi
}
trap cleanup EXIT

tar -xzf "$source_tar" -C "$build_dir"
if [[ ! -f /opt/bobbo/data/devices.json && "$initial_data_tar" != '-' ]]; then
  initial_data_tar="$(realpath -- "$initial_data_tar")"
  tar -xzf "$initial_data_tar" -C /opt/bobbo
fi

backup_dir="/opt/bobbo/backups/$(date +%Y%m%d-%H%M%S)-${release_tag}-predeploy"
install -d -m 0700 "$backup_dir"
if docker container inspect bobbo-backend >/dev/null 2>&1 \
  && [[ "$(docker container inspect --format '{{.State.Running}} {{.State.Paused}}' bobbo-backend)" == 'true false' ]]; then
  docker pause bobbo-backend >/dev/null
  backend_paused=1
fi
tar --numeric-owner -C / -czf "$backup_dir/runtime.tgz" opt/bobbo/data opt/bobbo/secrets/app.env
resume_backend
chmod 0600 "$backup_dir/runtime.tgz"
install -m 0600 "$env_file" /opt/bobbo/secrets/app.env

docker build --pull -t "$image" "$build_dir"
had_current=0
if docker container inspect bobbo-backend >/dev/null 2>&1; then
  had_current=1
  docker rm -f "$rollback_name" >/dev/null 2>&1 || true
  docker stop bobbo-backend >/dev/null
  docker rename bobbo-backend "$rollback_name"
fi

rollback() {
  docker rm -f bobbo-backend >/dev/null 2>&1 || true
  if [[ "$had_current" -eq 1 ]]; then
    docker rename "$rollback_name" bobbo-backend
    docker start bobbo-backend >/dev/null
  fi
}

if ! docker run -d \
  --name bobbo-backend \
  --restart unless-stopped \
  --cpus 4 \
  --memory 6g \
  --memory-swap 10g \
  --log-opt max-size=20m \
  --log-opt max-file=3 \
  --env-file /opt/bobbo/secrets/app.env \
  --publish 127.0.0.1:3000:3000 \
  --volume /opt/bobbo/data:/app/server/data \
  --volume /opt/bobbo/logs:/app/server/logs \
  "$image" >/dev/null; then
  rollback
  exit 1
fi

healthy=0
for _attempt in $(seq 1 60); do
  if curl --silent --show-error --fail --max-time 3 http://127.0.0.1:3000/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ "$healthy" -ne 1 ]]; then
  docker logs --tail 200 bobbo-backend >&2 || true
  rollback
  exit 1
fi

if [[ "$had_current" -eq 1 ]]; then
  docker rm -f "$rollback_name" >/dev/null
fi
"$(dirname "$(realpath -- "$0")")/ecs-retention.sh"
echo "DEPLOY_OK $image"
