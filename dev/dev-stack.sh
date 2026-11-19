#!/bin/bash
# =====================================================================
# dev-stack.sh - the local test stack without Docker.
#
# dev/docker-compose.yml is the reference stack (PostgreSQL 16 +
# PostgREST 12.2.3, the same versions as production). It needs a
# container runtime. This script brings the same stack up natively, for
# machines that have neither Docker nor Podman - a CI container, a
# locked-down box, a sandbox.
#
#   ./dev/dev-stack.sh up        # start Postgres + PostgREST
#   ./dev/dev-stack.sh status    # what is running
#   ./dev/dev-stack.sh down      # stop both
#   ./dev/dev-stack.sh reset     # stop, wipe the data, start from scratch
#
# Same ports and same schema as the compose file, so
# tests/e2e/save-workout.db.spec.js talks to it unchanged:
#
#   PostgREST: http://localhost:${DEV_POSTGREST_PORT:-3001}
#   Postgres:  localhost:${DEV_PG_PORT:-5433}  (postgres / postgres, db xesync)
#
# The schema is applied exactly like docker-entrypoint-initdb.d does,
# in the same alphabetical order, so a local run is a faithful rehearsal
# of a migration:
#
#   00-roles.sql -> xesync_schema.sql -> 60-worker-grants.sql -> 70-seed.sql
#
# Environment:
#   DEV_PG_PORT          Postgres port          (default 5433)
#   DEV_POSTGREST_PORT   PostgREST port         (default 3001)
#   DEV_PG_DATA          Postgres data dir      (default $PGDATA_BASE/xesync-dev)
#   PGRST_BIN            PostgREST binary       (default ./dev/.postgrest/postgrest)
#   PGRST_VERSION        PostgREST version      (default 12.2.3)
#
# The data dir MUST be on a local filesystem. On a network mount (NFS,
# SMB) initdb and every write are orders of magnitude slower, and a
# Postgres cluster on NFS is not a thing you want to debug.
# =====================================================================

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PGDATA_BASE="${PGDATA_BASE:-/var/lib/postgresql/16}"
DEV_PG_PORT="${DEV_PG_PORT:-5433}"
DEV_POSTGREST_PORT="${DEV_POSTGREST_PORT:-3001}"
DEV_PG_DATA="${DEV_PG_DATA:-$PGDATA_BASE/xesync-dev}"
PGRST_VERSION="${PGRST_VERSION:-12.2.3}"
PGRST_DIR="$REPO/dev/.postgrest"
PGRST_BIN="${PGRST_BIN:-$PGRST_DIR/postgrest}"
RUNDIR="$DEV_PG_DATA/run"
PG_LOG="$DEV_PG_DATA/pg.log"
PGRST_LOG="$DEV_PG_DATA/postgrest.log"

say() { echo "==> $*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing: $1" >&2
    exit 1
  }
}

# Postgres refuses to run as root, so the cluster belongs to the
# 'postgres' system user when we are root.
as_pg() {
  if [ "$(id -u)" -eq 0 ]; then
    su postgres -c "$1"
  else
    bash -c "$1"
  fi
}

ensure_postgrest() {
  if [ -x "$PGRST_BIN" ]; then return; fi
  need curl
  mkdir -p "$PGRST_DIR"
  say "downloading PostgREST $PGRST_VERSION"
  curl -fsSL -o "$PGRST_DIR/postgrest.tar.xz" \
    "https://github.com/PostgREST/postgrest/releases/download/v${PGRST_VERSION}/postgrest-v${PGRST_VERSION}-linux-static-x64.tar.xz"
  tar -xJf "$PGRST_DIR/postgrest.tar.xz" -C "$PGRST_DIR"
  rm -f "$PGRST_DIR/postgrest.tar.xz"
  chmod +x "$PGRST_BIN"
}

start_postgres() {
  if as_pg "$PG_BIN/pg_ctl -D $DEV_PG_DATA status" >/dev/null 2>&1; then
    say "Postgres already running"
    return
  fi
  as_pg "$PG_BIN/pg_ctl -D $DEV_PG_DATA -l $PG_LOG -w start \
    -o '-p $DEV_PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$RUNDIR'"
}

stop_postgres() {
  as_pg "$PG_BIN/pg_ctl -D $DEV_PG_DATA -m fast -w stop" || true
}

start_postgrest() {
  if postgrest_up; then
    say "PostgREST already running"
    return
  fi
  PGRST_DB_URI="postgres://xesync:xesync_dev_pw@127.0.0.1:${DEV_PG_PORT}/xesync" \
  PGRST_DB_SCHEMAS=xesync \
  PGRST_DB_ANON_ROLE=web_anon \
  PGRST_SERVER_HOST=0.0.0.0 \
  PGRST_SERVER_PORT="$DEV_POSTGREST_PORT" \
  PGRST_LOG_LEVEL=error \
    nohup "$PGRST_BIN" >"$PGRST_LOG" 2>&1 &
  sleep 2
}

# Ask the server itself rather than matching a process name: the binary
# may have been started from another location, and the answer is the
# thing that matters.
postgrest_up() {
  curl -sS -m 5 -o /dev/null -X POST "http://localhost:${DEV_POSTGREST_PORT}/rpc/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"__probe__","password":"__probe__"}' 2>/dev/null
}

case "${1:-up}" in
  up)
    need pg_ctl
    ensure_postgrest
    if [ ! -f "$DEV_PG_DATA/PG_VERSION" ]; then
      say "initdb -> $DEV_PG_DATA"
      rm -rf "$DEV_PG_DATA"
      mkdir -p "$DEV_PG_DATA" "$RUNDIR"
      if [ "$(id -u)" -eq 0 ]; then
        chown -R postgres:postgres "$DEV_PG_DATA"
        chmod 700 "$DEV_PG_DATA"
      fi
      as_pg "$PG_BIN/initdb -D $DEV_PG_DATA -U postgres --auth-local=trust --auth-host=trust" >/dev/null
    fi
    start_postgres
    # The schema is idempotent; reapplying it is what pgsql/migrate.sh
    # does against production.
    as_pg "$PG_BIN/psql -h 127.0.0.1 -p $DEV_PG_PORT -U postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='xesync'\"" \
      | grep -q 1 || as_pg "$PG_BIN/createdb -h 127.0.0.1 -p $DEV_PG_PORT -U postgres xesync"
    for f in dev/db-init/00-roles.sql pgsql/xesync_schema.sql dev/db-init/60-worker-grants.sql dev/db-init/70-seed.sql; do
      say "applying $f"
      as_pg "$PG_BIN/psql -h 127.0.0.1 -p $DEV_PG_PORT -U postgres -d xesync -v ON_ERROR_STOP=1 -f '$REPO/$f'" >/dev/null
    done
    start_postgrest
    say "PostgREST: http://localhost:$DEV_POSTGREST_PORT   Postgres: localhost:$DEV_PG_PORT"
    ;;
  down)
    pkill -f postgrest 2>/dev/null || true
    stop_postgres
    say "stopped"
    ;;
  reset)
    "$0" down
    rm -rf "$DEV_PG_DATA"
    "$0" up
    ;;
  status)
    as_pg "$PG_BIN/pg_ctl -D $DEV_PG_DATA status" || echo "Postgres: down"
    if postgrest_up; then echo "PostgREST: up"; else echo "PostgREST: down"; fi
    curl -sS -m 5 -X POST "http://localhost:$DEV_POSTGREST_PORT/rpc/login" \
      -H 'Content-Type: application/json' \
      -d '{"username":"e2e_test_user","password":"E2eTestPass123!"}' || echo "no answer"
    echo
    ;;
  *)
    echo "usage: $0 {up|down|reset|status}" >&2
    exit 1
    ;;
esac
