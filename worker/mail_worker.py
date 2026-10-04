#!/usr/bin/env python3
"""
XeSync email queue worker.

Reads pending rows from xesync.email_queue and sends them via SMTP
(STARTTLS + AUTH when SMTP_USER is set — e.g. ZeptoMail; plain unauthenticated
relay otherwise). Run from cron every minute.

Configuration via /etc/xesync/mail.env:

  PG_DSN=postgresql://xesync_worker:password@localhost:5432/xesync
  SMTP_HOST=smtp.zeptomail.eu
  SMTP_PORT=587
  SMTP_USER=emailapikey
  SMTP_PASS=<Zepto send-mail token>
  SMTP_FROM=noreply@intarynx.com
"""

import os
import sys
import smtplib
import logging
from email.message import EmailMessage

import psycopg


# ── Config ──────────────────────────────────────────────────────────────────
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

PG_DSN     = os.environ['PG_DSN']
SMTP_HOST  = os.environ.get('SMTP_HOST', 'localhost')
SMTP_PORT  = int(os.environ.get('SMTP_PORT', '25'))
SMTP_USER  = os.environ.get('SMTP_USER', '')
SMTP_PASS  = os.environ.get('SMTP_PASS', '')
SMTP_FROM  = os.environ.get('SMTP_FROM', 'noreply@intarynx.com')
BATCH_SIZE = int(os.environ.get('BATCH_SIZE', '20'))


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger('mail_worker')


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    with psycopg.connect(PG_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, to_addr, subject, body "
                "FROM xesync.email_queue_claim(%s)",
                (BATCH_SIZE,)
            )
            rows = cur.fetchall()
        # email_queue_claim() stamps claimed_at on these rows so a worker run
        # that overlaps the next minute's cron tick won't claim them again -
        # that only holds if the stamp is committed now, before the SMTP
        # round-trips below, rather than left pending on this connection.
        conn.commit()

        if not rows:
            return

        log.info('Claimed %d email(s) to send', len(rows))

        smtp = None
        try:
            smtp = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
            smtp.ehlo()
            if SMTP_USER:
                smtp.starttls()
                smtp.ehlo()
                smtp.login(SMTP_USER, SMTP_PASS)

            for qid, to_addr, subject, body in rows:
                try:
                    msg = EmailMessage()
                    msg['From']    = SMTP_FROM
                    msg['To']      = to_addr
                    msg['Subject'] = subject
                    msg.set_content(body)
                    smtp.send_message(msg)

                    with conn.cursor() as cur:
                        cur.execute("SELECT xesync.email_queue_mark_sent(%s)", (qid,))
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
