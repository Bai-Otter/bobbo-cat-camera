#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  echo 'usage: ecs-vision-worker-deploy.sh <release-tag> <source-tar> <env-file>' >&2
  exit 2
fi

release_tag="$1"
source_tar="$(realpath -- "$2")"
env_file="$(realpath -- "$3")"
[[ "$release_tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'invalid release tag' >&2; exit 2; }
[[ -f "$source_tar" ]] || { echo 'source archive not found' >&2; exit 1; }
[[ -f "$env_file" ]] || { echo 'environment file not found' >&2; exit 1; }

install -d -m 0755 /opt/bobbo-vision
install -d -m 0700 /opt/bobbo-vision/secrets
build_dir="$(mktemp -d /opt/bobbo-vision/build.XXXXXX)"
cleanup() {
  local resolved
  resolved="$(realpath -m -- "$build_dir")"
  if [[ "$resolved" == /opt/bobbo-vision/build.* ]]; then rm -rf -- "$resolved"; fi
}
trap cleanup EXIT

tar -xzf "$source_tar" -C "$build_dir"
install -m 0600 "$env_file" /opt/bobbo-vision/secrets/worker.env
image="bobbo-vision-worker:${release_tag}"
docker build --pull -t "$image" "$build_dir"
docker rm -f bobbo-vision-worker >/dev/null 2>&1 || true
docker run -d \
  --name bobbo-vision-worker \
  --restart unless-stopped \
  --cpus 4 \
  --memory 6g \
  --memory-swap 7g \
  --pids-limit 512 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=2g \
  --tmpfs /app/server/data:rw,noexec,nosuid,size=64m \
  --log-opt max-size=20m \
  --log-opt max-file=3 \
  --env-file /opt/bobbo-vision/secrets/worker.env \
  --publish 3100:3100 \
  "$image" node server/src/feedAnalysis/visionHttpServer.js >/dev/null

for _attempt in $(seq 1 90); do
  if curl --silent --show-error --fail --max-time 3 http://127.0.0.1:3100/health >/dev/null; then
    echo "DEPLOY_OK $image"
    exit 0
  fi
  sleep 2
done

docker logs --tail 200 bobbo-vision-worker >&2 || true
exit 1
