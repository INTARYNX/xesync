#!/usr/bin/env python3
"""
XeSync email queue worker.

Reads pending rows from xesync.email_queue and sends them via SMTP.
Run from cron every minute (or two). Safe to run multiple times — uses
attempts counter and sent_at to avoid double-sending.

Configuration via environment or /etc/xesync/mail.env (see EXAMPLES below).

  PG_DSN=postgresql://xesync_worker:password@localhost:5432/xesync
  SMTP_HOST=mail.infomaniak.com
  SMTP_PORT=587
  SMTP_USER=noreply@enlistia.com
  SMTP_PASSWORD=...
  SMTP_FROM=XeSync <noreply@enlistia.com>
  SMTP_USE_TLS=1
"""

import os
import sys
import smtplib
import logging
from email.message import EmailMessage
from email.utils import formataddr

try:
    import psycopg                        # psycopg3
    PSYCOPG_V3 = True
except ImportError:
    import psycopg2 as psycopg            # fallback
    PSYCOPG_V3 = False


# ── Config loading ──────────────────────────────────────────────────────────
def load_env_file(path):
    if not os.path.isfile(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env_file('/etc/xesync/mail.env')

PG_DSN        = os.environ['PG_DSN']
SMTP_HOST     = os.environ['SMTP_HOST']
SMTP_PORT     = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER     = os.environ.get('SMTP_USER')
SMTP_PASSWORD = os.environ.get('SMTP_PASSWORD')
SMTP_FROM     = os.environ['SMTP_FROM']
SMTP_USE_TLS  = os.environ.get('SMTP_USE_TLS', '1') == '1'
BATCH_SIZE    = int(os.environ.get('BATCH_SIZE', '20'))


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger('mail_worker')


# ── SMTP ────────────────────────────────────────────────────────────────────
def send_one(smtp, to_addr, subject, body):
    msg = EmailMessage()
    msg['From']    = SMTP_FROM
    msg['To']      = to_addr
    msg['Subject'] = subject
    msg.set_content(body)
    smtp.send_message(msg)


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    with psycopg.connect(PG_DSN) as conn:
        if not PSYCOPG_V3:
            conn.autocommit = False
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, to_addr, subject, body "
                "FROM xesync.email_queue_claim(%s)",
                (BATCH_SIZE,)
            )
            rows = cur.fetchall()

        if not rows:
            return

        log.info('Claimed %d email(s) to send', len(rows))

        smtp = None
        try:
            smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
            smtp.ehlo()
            if SMTP_USE_TLS:
                smtp.starttls()
                smtp.ehlo()
            if SMTP_USER and SMTP_PASSWORD:
                smtp.login(SMTP_USER, SMTP_PASSWORD)

            for row in rows:
                qid, to_addr, subject, body = row
                try:
                    send_one(smtp, to_addr, subject, body)
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT xesync.email_queue_mark_sent(%s)",
                            (qid,)
                        )
                    conn.commit()
                    log.info('Sent #%s → %s', qid, to_addr)
                except Exception as e:
                    err = str(e)[:500]
                    log.warning('Failed #%s → %s: %s', qid, to_addr, err)
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT xesync.email_queue_mark_failed(%s, %s)",
                            (qid, err)
                        )
                    conn.commit()
        finally:
            if smtp is not None:
                try:
                    smtp.quit()
                except Exception:
                    pass


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log.error('Worker crashed: %s', e)
        sys.exit(1)