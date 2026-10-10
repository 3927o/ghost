#!/bin/sh
set -eu
umask 022
app=$1 health=$2 commit=$3
shift 3
cd "$app"
[ ! -L .deploy.lock ]
exec 9>.deploy.lock
flock -n 9 || { echo '[deploy] Another deployment is running.' >&2; exit 1; }
[ ! -e current ] && [ ! -L current ] || { echo '[deploy] Migrate the old release layout first.' >&2; exit 1; }
[ -f .env ] && [ ! -L .env ] && [ -d data ] && [ ! -L data ] || {
  echo '[deploy] Prepare .env and data in the application directory first.' >&2; exit 1;
}
for tool in node npm tar curl systemctl; do command -v "$tool" >/dev/null; done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
service() {
  if [ "$(id -u)" = 0 ]; then systemctl "$@"; else sudo -n systemctl "$@"; fi
}
service cat -- "$@" >/dev/null
incoming=$(mktemp -d "$app/.deploy.XXXXXX")
trap 'rm -rf -- "$incoming"' EXIT
trap 'exit 1' HUP INT TERM
tar --no-same-owner -xzf - -C "$incoming"
for name in apps packages dist; do
  [ -d "$incoming/$name" ] && [ ! -L "$incoming/$name" ] || { echo '[deploy] Incomplete upload.' >&2; exit 1; }
done
for name in package.json package-lock.json; do
  [ -f "$incoming/$name" ] && [ ! -L "$incoming/$name" ] || { echo '[deploy] Incomplete upload.' >&2; exit 1; }
done

echo '[deploy] Updating application files.'
service stop -- "$@"
# Only these code/build files are replaced. .env and data never enter this list.
for name in apps packages dist package.json package-lock.json; do
  rm -rf -- "$name"
  mv -- "$incoming/$name" "$name"
done
rm -f -- .deploy-commit
printf '%s\n' "$commit" >.deploy-commit
echo '[deploy] Installing production dependencies.'
npm ci --omit=dev --no-audit --no-fund
echo '[deploy] Starting application services.'
service start -- "$@"

deadline=$(( $(date +%s) + 60 ))
stable=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  healthy=true
  for unit in "$@"; do service is-active --quiet -- "$unit" || healthy=false; done
  if "$healthy" && curl --fail --silent --max-time 2 "$health" >/dev/null; then
    stable=$((stable + 1))
    if [ "$stable" -ge 3 ]; then
      echo '[deploy] Deployment complete.'
      exit 0
    fi
  else
    stable=0
  fi
  sleep 1
done
echo '[deploy] Health checks failed. Inspect the services or redeploy a known good commit with --ref.' >&2
exit 1
