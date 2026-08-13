-- =====================================================================
-- Local dev roles/schema — mirrors dev/postgresql.md and
-- worker/setup_worker.sh exactly, so permission bugs (e.g. the
-- user_id_from_token() grant gap) show up locally instead of only in prod.
--
-- Runs once, as the postgres superuser, on first container init
-- (docker-entrypoint-initdb.d semantics: skipped if the data volume
-- already has a database).
-- =====================================================================

CREATE ROLE xesync WITH LOGIN PASSWORD 'xesync_dev_pw';
CREATE ROLE web_anon NOLOGIN;
CREATE ROLE xesync_worker WITH LOGIN PASSWORD 'worker_dev_pw';

CREATE SCHEMA IF NOT EXISTS xesync AUTHORIZATION xesync;

GRANT web_anon TO xesync;

-- pgsql/xesync_schema.sql (mounted as 50-xesync_schema.sql) and
-- worker/setup_worker.sh's grants both assume pgcrypto is already
-- available; the schema file also does this, kept here too since role
-- creation happens before it runs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
