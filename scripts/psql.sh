#!/usr/bin/env bash
# psql without a local Postgres install: runs the postgres:17 client in Docker.
# The connection URL is read from .env.local by variable name so it never appears in shell
# history or process listings outside the container.
#
#   scripts/psql.sh PROD_RO_DATABASE_URL -c 'select count(*) from saves'
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <ENV_VAR_NAME> [psql args...]" >&2
  exit 2
fi

var_name="$1"
shift
repo_root="$(cd "$(dirname "$0")/.." && pwd)"

set -a
# shellcheck disable=SC1091
source "$repo_root/.env.local"
set +a

url="${!var_name:-}"
if [[ -z "$url" ]]; then
  echo "$var_name is not set in .env.local" >&2
  exit 1
fi

tty_flag=()
[[ -t 0 && -t 1 ]] && tty_flag=(-it)
exec docker run --rm "${tty_flag[@]}" --network host -e DATABASE_URL="$url" postgres:17-alpine \
  sh -c 'exec psql "$DATABASE_URL" "$@"' psql "$@"
