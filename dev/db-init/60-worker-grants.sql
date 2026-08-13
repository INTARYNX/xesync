-- Mirrors worker/setup_worker.sh's grants (that script is Linux/systemd-only
-- and can't run in this container, but the grants it applies are what keeps
-- xesync_worker's access identical between local and prod).
GRANT USAGE ON SCHEMA xesync TO xesync_worker;
GRANT EXECUTE ON FUNCTION xesync.email_queue_claim(INTEGER)            TO xesync_worker;
GRANT EXECUTE ON FUNCTION xesync.email_queue_mark_sent(BIGINT)         TO xesync_worker;
GRANT EXECUTE ON FUNCTION xesync.email_queue_mark_failed(BIGINT, TEXT) TO xesync_worker;
