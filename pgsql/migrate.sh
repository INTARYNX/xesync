#!/usr/bin/env bash
# ============================================================================
# XeSync — migration script
# Idempotent: safe to re-run on an existing installation.
# Applies schema changes without dropping data, then reloads PostgREST.
#
# Usage:  sudo bash migrate.sh
# ============================================================================
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
DB_NAME="${DB_NAME:-xesync}"
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
[ "$EUID" -eq 0 ] || fail "Run as root (sudo bash migrate.sh)"
require_cmd psql
require_cmd systemctl
[ -f "$SCHEMA_FILE" ] || fail "Schema file not found: $SCHEMA_FILE"

# Verify the database exists
psql_super -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" \
    | grep -q 1 || fail "Database '$DB_NAME' does not exist. Run install.sh first."

# ── Column migrations (ADD COLUMN IF NOT EXISTS) ─────────────────────────────
log "Migrating users table columns…"
psql_super -d "$DB_NAME" <<'SQL'
ALTER TABLE xesync.users
    ADD COLUMN IF NOT EXISTS email           VARCHAR(255),
    ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE;
SQL

# Backfill: existing users (created before email flow) are considered active
psql_super -d "$DB_NAME" -c \
    "UPDATE xesync.users SET is_active = TRUE WHERE is_active IS DISTINCT FROM TRUE AND email IS NULL;"

ok "Columns migrated."

# ── Apply full schema (idempotent — CREATE IF NOT EXISTS + CREATE OR REPLACE) ─
log "Applying schema '$SCHEMA_FILE'…"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$SCHEMA_FILE" \
    || fail "Schema apply failed. See errors above."
ok "Schema applied."

# ── Sanity check ────────────────────────────────────────────────────────────
log "Verifying objects…"
TABLE_COUNT=$(psql_super -d "$DB_NAME" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='xesync';")
FUNC_COUNT=$(psql_super -d "$DB_NAME" -tAc \
    "SELECT count(*) FROM information_schema.routines WHERE specific_schema='xesync';")
ok "Schema 'xesync' has $TABLE_COUNT tables and $FUNC_COUNT functions."

# ── Permission surface check ─────────────────────────────────────────────────
# The schema is default-deny (see the PERMISSIONS section of
# xesync_schema.sql), but a default-deny policy is only as good as the
# allowlist actually matching intent - that's exactly how
# user_id_from_token() ended up reachable by web_anon in the first place:
# nothing enumerated it as forbidden, so PostgreSQL's implicit PUBLIC grant
# stood. This turns that audit into something that runs on every future
# migration instead of a one-time manual check.
log "Verifying web_anon's function grants…"
EXPECTED_WEB_ANON_FUNCS=$(cat <<'EOF'
change_password(text,text,text)
delete_account(text,text)
export_account(text)
get_workout(text,text)
list_workouts(text)
log_rawdata(text,text)
log_rawdata(text,text,text)
login(text,text)
register(text,text,text)
request_password_reset(text)
resend_verification(text)
reset_password_with_token(text,text)
save_workout(text,text,jsonb)
validate_token(text)
verify_email(text)
EOF
)
ACTUAL_WEB_ANON_FUNCS=$(psql_super -d "$DB_NAME" -tAc "
    SELECT p.proname || '(' || array_to_string(ARRAY(
               SELECT format_type(t, NULL) FROM unnest(p.proargtypes) AS t
           ), ',') || ')'
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'xesync'
       AND has_function_privilege('web_anon', p.oid, 'EXECUTE')
     ORDER BY 1;
")

if [ "$ACTUAL_WEB_ANON_FUNCS" != "$EXPECTED_WEB_ANON_FUNCS" ]; then
    echo "--- expected ---"
    echo "$EXPECTED_WEB_ANON_FUNCS"
    echo "--- actual ---"
    echo "$ACTUAL_WEB_ANON_FUNCS"
    echo "--- diff (expected vs actual) ---"
    diff <(echo "$EXPECTED_WEB_ANON_FUNCS") <(echo "$ACTUAL_WEB_ANON_FUNCS") || true
    fail "web_anon's EXECUTE grants don't match the expected allowlist. A function is exposed that shouldn't be (or vice versa) - see the diff above before proceeding."
fi
ok "web_anon can reach exactly the intended $(echo "$ACTUAL_WEB_ANON_FUNCS" | wc -l) functions."

log "Verifying PUBLIC has no function grants…"
PUBLIC_FUNCS=$(psql_super -d "$DB_NAME" -tAc "
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'xesync'
       AND has_function_privilege('public', p.oid, 'EXECUTE');
")
[ -z "$PUBLIC_FUNCS" ] || fail "PUBLIC can execute functions it shouldn't: $PUBLIC_FUNCS"
ok "PUBLIC has zero function grants in the xesync schema."

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
ok "XeSync migrated."