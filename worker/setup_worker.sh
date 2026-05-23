#!/usr/bin/env bash
# ============================================================================
# XeSync — mail worker setup
# Usage:  sudo bash setup_worker.sh
# ============================================================================
set -euo pipefail

VENV_DIR="/opt/xesync-worker"
WORKER_SRC="$(dirname "$0")/mail_worker.py"
DB_NAME="${DB_NAME:-xesync}"
WORKER_USER="xesync_worker"
WORKER_PASSWORD="${WORKER_PASSWORD:-change-me}"

log()  { printf '\033[1;36m▶\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || fail "Run as root (sudo bash setup_worker.sh)"
[ -f "$WORKER_SRC" ] || fail "mail_worker.py not found next to this script"
command -v python3 >/dev/null 2>&1 || fail "python3 not found"

# ── 1. DB user ───────────────────────────────────────────────────────────────
log "Creating DB user '$WORKER_USER'…"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$WORKER_USER') THEN
        CREATE USER $WORKER_USER WITH PASSWORD '$WORKER_PASSWORD';
    ELSE
        ALTER USER $WORKER_USER WITH PASSWORD '$WORKER_PASSWORD';
    END IF;
END
\$\$;
GRANT USAGE ON SCHEMA xesync TO $WORKER_USER;
GRANT EXECUTE ON FUNCTION xesync.email_queue_claim(INTEGER)            TO $WORKER_USER;
GRANT EXECUTE ON FUNCTION xesync.email_queue_mark_sent(BIGINT)         TO $WORKER_USER;
GRANT EXECUTE ON FUNCTION xesync.email_queue_mark_failed(BIGINT, TEXT) TO $WORKER_USER;
SQL
ok "DB user ready."

# ── 2. Python venv ───────────────────────────────────────────────────────────
log "Setting up venv at $VENV_DIR…"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet psycopg[binary,pool]
ok "Venv ready."

# ── 3. Config ────────────────────────────────────────────────────────────────
log "Writing /etc/xesync/mail.env…"
mkdir -p /etc/xesync

# Only write if it doesn't exist — don't overwrite real credentials on re-run
if [ ! -f /etc/xesync/mail.env ]; then
    cat > /etc/xesync/mail.env <<EOF
PG_DSN=postgresql://$WORKER_USER:$WORKER_PASSWORD@localhost:5432/$DB_NAME
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_FROM=noreply@enlistia.com
EOF
    chmod 600 /etc/xesync/mail.env
    ok "mail.env written."
else
    ok "mail.env already exists — skipping (not overwritten)."
fi

# ── 4. Worker script ─────────────────────────────────────────────────────────
log "Installing mail_worker.py…"
cp "$WORKER_SRC" /usr/local/bin/xesync-mail-worker
chmod +x /usr/local/bin/xesync-mail-worker

# Patch shebang to use the venv interpreter
sed -i "1s|.*|#!$VENV_DIR/bin/python3|" /usr/local/bin/xesync-mail-worker
ok "Worker installed."

# ── 5. Cron ──────────────────────────────────────────────────────────────────
log "Installing cron job…"
cat > /etc/cron.d/xesync-mail <<EOF
* * * * * root /usr/local/bin/xesync-mail-worker >> /var/log/xesync-mail.log 2>&1
EOF
chmod 644 /etc/cron.d/xesync-mail
ok "Cron job installed (/etc/cron.d/xesync-mail)."

# ── Done ─────────────────────────────────────────────────────────────────────
echo
ok "Mail worker setup complete."
echo
echo "Next steps:"
echo "  1. Test manually:  sudo /usr/local/bin/xesync-mail-worker"
echo "  2. Watch logs:     sudo tail -f /var/log/xesync-mail.log"