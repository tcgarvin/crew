#!/usr/bin/env bash
# Creates the read-only role claude_ro on prod Neon (neon-crew / main / neondb) and appends
# PROD_RO_DATABASE_URL to .env.local. Owner credentials are never written to disk.
#
# The user runs this, not Claude: it changes the production database. Needs `neonctl auth` and
# Docker. If claude_ro already exists (e.g. on a new machine that only lost .env.local), drop it
# first in the Neon SQL editor or change CREATE ROLE to ALTER ROLE ... PASSWORD.
set -euo pipefail
cd "$(dirname "$0")/.."
P=restless-voice-83603994
OWNER_URL=$(neonctl connection-string main --project-id "$P" --database-name neondb --role-name neondb_owner)
PW=$(openssl rand -hex 24)
docker run --rm -i --network host -e DATABASE_URL="$OWNER_URL" -e PW="$PW" postgres:17-alpine \
  sh -c 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -v pw="$PW"' <<'SQL'
CREATE ROLE claude_ro WITH LOGIN PASSWORD :'pw';
GRANT CONNECT ON DATABASE neondb TO claude_ro;
GRANT USAGE ON SCHEMA public TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO claude_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    GRANT USAGE ON SCHEMA drizzle TO claude_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO claude_ro;
  END IF;
END $$;
ALTER ROLE claude_ro SET default_transaction_read_only = on;
SQL
RO_URL=$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(netloc=f"claude_ro:{sys.argv[2]}@{p.hostname}")))' "$OWNER_URL" "$PW")
printf '\n# Read-only prod Neon access for Claude (role claude_ro). Not DATABASE_URL on purpose.\nPROD_RO_DATABASE_URL="%s"\n' "$RO_URL" >> .env.local
echo "claude_ro created; PROD_RO_DATABASE_URL added to .env.local"
