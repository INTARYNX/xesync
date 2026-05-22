#!/usr/bin/env bash
# ============================================================================
# XeSync — PostgreSQL + PostgREST installer
# Idempotent: safe to re-run. Creates/updates schema, functions, and reloads
# PostgREST. Does not drop existing data.
#
# Usage:  sudo bash install.sh
# Requires: psql, postgres role, postgrest systemd unit
# ============================================================================
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
DB_NAME="${DB_NAME:-xesync}"
DB_OWNER="${DB_OWNER:-xesync}"
ANON_ROLE="${ANON_ROLE:-web_anon}"
SCHEMA_FILE="${SCHEMA_FILE:-$(dirname "$0")/xesync_schema.sql}"
POSTGREST_SERVICE="${POSTGREST_SERVICE:-postgrest}"

# ── Helpers ─────────────────────────────────────────────────────────────────
log()  { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

psql_super() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

# ── Sanity checks ───────────────────────────────────────────────────────────
[ "$EUID" -eq 0 ] || fail "Run as root (sudo bash install.sh)"
require_cmd psql
require_cmd systemctl
[ -f "$SCHEMA_FILE" ] || fail "Schema file not found: $SCHEMA_FILE"

# ── Apply schema ────────────────────────────────────────────────────────────
log "Applying schema to database '$DB_NAME'…"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$SCHEMA_FILE" \
    || fail "Schema apply failed. See errors above."
ok "Schema applied."

# ── Quick sanity check ──────────────────────────────────────────────────────
log "Verifying objects…"
TABLE_COUNT=$(psql_super -d "$DB_NAME" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='xesync';")
FUNC_COUNT=$(psql_super -d "$DB_NAME" -tAc \
    "SELECT count(*) FROM information_schema.routines WHERE specific_schema='xesync';")
ok "Schema 'xesync' has $TABLE_COUNT tables and $FUNC_COUNT functions."

# ── Reload PostgREST ────────────────────────────────────────────────────────
if systemctl is-active --quiet "$POSTGREST_SERVICE"; then
    log "Restarting $POSTGREST_SERVICE…"
    systemctl restart "$POSTGREST_SERVICE"
    sleep 1
    if systemctl is-active --quiet "$POSTGREST_SERVICE"; then
        ok "$POSTGREST_SERVICE running."
    else
        fail "$POSTGREST_SERVICE failed to start. Check: systemctl status $POSTGREST_SERVICE"
    fi
else
    log "$POSTGREST_SERVICE is not active — skipping restart."
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo
ok "XeSync installed."
echo
echo "Create a user with:"
echo "    sudo -u postgres psql -d $DB_NAME -c \"SELECT xesync.create_user('myuser', 'mypassword');\""
echo
echo "Test the API:"
echo "    curl -X POST http://localhost:3000/rpc/login \\"
echo "        -H 'Content-Type: application/json' \\"
echo "        -d '{\"username\":\"myuser\",\"password\":\"mypassword\"}'"