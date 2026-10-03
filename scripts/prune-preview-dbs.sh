#!/usr/bin/env bash
# Lists Neon `preview/<git-branch>` database branches whose git branch no longer exists on
# origin. Dry run by default; pass --delete to remove them. Only `preview/*` branches are ever
# candidates, so prod (`main`) and ad-hoc work branches are never touched.
#
#   scripts/prune-preview-dbs.sh            # report only
#   scripts/prune-preview-dbs.sh --delete   # delete the stale ones
set -euo pipefail

project_id="restless-voice-83603994"

delete=false
case "${1:-}" in
  "") ;;
  --delete) delete=true ;;
  *)
    echo "usage: $0 [--delete]" >&2
    exit 2
    ;;
esac

remote_heads="$(git ls-remote --heads origin | sed 's#.*refs/heads/##')"
preview_dbs="$(neonctl branches list --project-id "$project_id" --output json |
  jq -r '.[] | select(.name | startswith("preview/")) | .name')"

stale=()
while IFS= read -r db_branch; do
  [[ -z "$db_branch" ]] && continue
  git_branch="${db_branch#preview/}"
  if ! grep -qxF -- "$git_branch" <<<"$remote_heads"; then
    stale+=("$db_branch")
  fi
done <<<"$preview_dbs"

if [[ ${#stale[@]} -eq 0 ]]; then
  echo "No stale preview database branches."
  exit 0
fi

for db_branch in "${stale[@]}"; do
  if $delete; then
    neonctl branches delete "$db_branch" --project-id "$project_id" >/dev/null
    echo "deleted $db_branch"
  else
    echo "stale $db_branch"
  fi
done
