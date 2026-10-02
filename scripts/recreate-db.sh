#!/usr/bin/env bash
# Drops and recreates the Subcult database from db/schema.sql. The indexer then rebuilds it from the chain.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-postgres-postgres-1}"
DB_NAME="${DB_NAME:-subcult}"
DB_USER="${DB_USER:-subcult}"
DB_PASSWORD="${DB_PASSWORD:-}"
SCHEMA="$(cd "$(dirname "$0")/.." && pwd)/db/schema.sql"

PG_ADMIN="${PG_ADMIN:-$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER)}"

admin() { docker exec -i "$PG_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "$PG_ADMIN" "$@"; }

echo "Container: $PG_CONTAINER, admin: $PG_ADMIN, database: $DB_NAME, owner: $DB_USER"
read -r -p "This permanently deletes database '$DB_NAME'. Type its name to continue: " answer
[ "$answer" = "$DB_NAME" ] || { echo "Aborted."; exit 1; }

role_exists=$(admin -d postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'")
if [ -z "$role_exists" ]; then
    [ -n "$DB_PASSWORD" ] || { echo "Role '$DB_USER' does not exist; set DB_PASSWORD to create it."; exit 1; }
    admin -d postgres -v user="$DB_USER" -v pw="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'user', :'pw') \gexec
SQL
    echo "Created role $DB_USER"
fi

admin -d postgres -v db="$DB_NAME" -v user="$DB_USER" <<'SQL'
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'db') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'user') \gexec
SQL
admin -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
docker exec -i "$PG_CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SCHEMA"

echo "Recreated $DB_NAME. Running backend and indexer reconnect on their own; the indexer rescans from START_BLOCK."
