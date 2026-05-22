-- ============================================================================
-- XeSync PostgreSQL schema
--
-- Idempotent: safe to re-run. Creates schema objects only if missing,
-- replaces functions in place.
--
-- Prerequisites:
--   - database `xesync` exists
--   - schema `xesync` owned by role `xesync`
--   - role `web_anon` (NOLOGIN) used as PostgREST's db-anon-role
--
-- Run:
--   sudo -u postgres psql -d xesync -f xesync_schema.sql
-- ============================================================================

SET search_path TO xesync, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================================
-- TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS xesync.users (
    user_id          BIGSERIAL PRIMARY KEY,
    user_name        VARCHAR(100) NOT NULL UNIQUE,
    password_hash    VARCHAR(100) NOT NULL,
    user_token       VARCHAR(64),
    token_expiry     TIMESTAMPTZ,
    last_connection  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_token
    ON xesync.users (user_token) WHERE user_token IS NOT NULL;


CREATE TABLE IF NOT EXISTS xesync.workouts (
    workout_id      VARCHAR(50) PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES xesync.users(user_id) ON DELETE CASCADE,
    workout_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
    data_version    SMALLINT    NOT NULL DEFAULT 1,
    duration_sec    INTEGER     NOT NULL CHECK (duration_sec >= 0),
    distance_m      INTEGER     NOT NULL CHECK (distance_m   >= 0),
    total_strokes   INTEGER     NOT NULL,
    calories        INTEGER,
    avg_spm         NUMERIC(5,1),
    avg_pace_sec    INTEGER,
    avg_watts       INTEGER,
    avg_hr          INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workouts_user ON xesync.workouts (user_id);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON xesync.workouts (workout_date);


CREATE TABLE IF NOT EXISTS xesync.workout_strokes (
    stroke_id       BIGSERIAL PRIMARY KEY,
    workout_id      VARCHAR(50) NOT NULL REFERENCES xesync.workouts(workout_id) ON DELETE CASCADE,
    stroke_number   INTEGER     NOT NULL,
    time_sec        NUMERIC(10,1) NOT NULL,
    distance_m      INTEGER     NOT NULL,
    spm             NUMERIC(5,1) NOT NULL,
    watts           INTEGER     NOT NULL,
    heartrate       INTEGER,
    pace_sec        INTEGER     NOT NULL,
    UNIQUE (workout_id, stroke_number)
);

CREATE INDEX IF NOT EXISTS idx_strokes_workout ON xesync.workout_strokes (workout_id);


CREATE TABLE IF NOT EXISTS xesync.workout_data (
    id          BIGSERIAL PRIMARY KEY,
    data        JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS xesync.ftms_rawdata (
    id           BIGSERIAL PRIMARY KEY,
    insert_date  TIMESTAMPTZ NOT NULL,
    raw_data     TEXT        NOT NULL
);


-- ============================================================================
-- HELPERS
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.random_hex(p_length INTEGER)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT substr(encode(gen_random_bytes(ceil(p_length / 2.0)::int), 'hex'), 1, p_length);
$$;


CREATE OR REPLACE FUNCTION xesync.token_validity_days()
RETURNS INTEGER
LANGUAGE sql IMMUTABLE
AS $$
    SELECT 30;
$$;


CREATE OR REPLACE FUNCTION xesync.user_id_from_token(p_token TEXT)
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
    SELECT user_id FROM xesync.users
     WHERE user_token   = p_token
       AND token_expiry > now()
    LIMIT 1;
$$;


-- ============================================================================
-- AUTH
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.login(username TEXT, password TEXT)
RETURNS TABLE (status TEXT, token TEXT, username_out TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_hash    TEXT;
    v_token   TEXT;
BEGIN
    IF username IS NULL OR password IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, NULL::TEXT, 'Missing username or password'::TEXT;
        RETURN;
    END IF;

    SELECT u.user_id, u.password_hash
      INTO v_user_id, v_hash
      FROM xesync.users u
     WHERE lower(u.user_name) = lower(username);

    IF v_user_id IS NULL OR v_hash IS NULL OR crypt(password, v_hash) <> v_hash THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, NULL::TEXT, 'Invalid username or password'::TEXT;
        RETURN;
    END IF;

    v_token := xesync.random_hex(64);

    UPDATE xesync.users
       SET user_token      = v_token,
           token_expiry    = now() + (xesync.token_validity_days() || ' days')::interval,
           last_connection = now()
     WHERE user_id = v_user_id;

    RETURN QUERY SELECT 'success'::TEXT, v_token, username, NULL::TEXT;
END;
$$;


CREATE OR REPLACE FUNCTION xesync.validate_token(token TEXT)
RETURNS TABLE (status TEXT, username TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_username TEXT;
BEGIN
    IF token IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, 'Missing token'::TEXT;
        RETURN;
    END IF;

    SELECT u.user_name INTO v_username
      FROM xesync.users u
     WHERE u.user_token   = validate_token.token
       AND u.token_expiry > now();

    IF v_username IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, 'Invalid or expired token'::TEXT;
        RETURN;
    END IF;

    UPDATE xesync.users
       SET token_expiry    = now() + (xesync.token_validity_days() || ' days')::interval,
           last_connection = now()
     WHERE user_token = validate_token.token;

    RETURN QUERY SELECT 'success'::TEXT, v_username, NULL::TEXT;
END;
$$;


-- ============================================================================
-- USER MANAGEMENT (admin only, not exposed to web_anon)
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.create_user(p_username TEXT, p_password TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    IF p_username IS NULL OR p_password IS NULL THEN
        RAISE EXCEPTION 'Username and password are required';
    END IF;
    IF length(p_password) < 8 THEN
        RAISE EXCEPTION 'Password must be at least 8 characters';
    END IF;

    INSERT INTO xesync.users (user_name, password_hash)
    VALUES (trim(p_username), crypt(p_password, gen_salt('bf', 10)))
    RETURNING user_id INTO v_id;

    RETURN v_id;
END;
$$;


CREATE OR REPLACE FUNCTION xesync.reset_password(p_username TEXT, p_password TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_username IS NULL OR p_password IS NULL THEN
        RAISE EXCEPTION 'Username and password are required';
    END IF;
    IF length(p_password) < 8 THEN
        RAISE EXCEPTION 'Password must be at least 8 characters';
    END IF;

    UPDATE xesync.users
       SET password_hash = crypt(p_password, gen_salt('bf', 10)),
           user_token    = NULL,
           token_expiry  = NULL
     WHERE lower(user_name) = lower(p_username);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found: %', p_username;
    END IF;
END;
$$;


-- ============================================================================
-- SAVE WORKOUT
--
-- Expected payload (flat — no double-encoding):
--   {
--     "token":   "<token>",
--     "workout": "workout_YYYYMMDDHHmmss",
--     "data": {
--       "version": 1,
--       "summary": { duration, distance, strokes, calories, avgSpm, avgPace, avgWatts, avgHr },
--       "samples": [ [time, distance, strokes_count, spm, watts, hr, pace], ... ]
--     }
--   }
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.save_workout(token TEXT, workout TEXT, data JSONB)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_summary JSONB;
    v_sample  JSONB;
    v_idx     INTEGER := 0;
BEGIN
    IF token IS NULL OR workout IS NULL OR data IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing token, workout or data'::TEXT;
        RETURN;
    END IF;

    INSERT INTO xesync.workout_data(data) VALUES (data);

    v_user_id := xesync.user_id_from_token(token);
    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Invalid or expired token'::TEXT;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM xesync.workouts WHERE workout_id = workout) THEN
        RETURN QUERY SELECT 'success'::TEXT, 'Data already processed'::TEXT;
        RETURN;
    END IF;

    v_summary := data -> 'summary';

    INSERT INTO xesync.workouts (
        workout_id, user_id, data_version,
        duration_sec, distance_m, total_strokes,
        calories, avg_spm, avg_pace_sec, avg_watts, avg_hr
    ) VALUES (
        workout,
        v_user_id,
        COALESCE((data ->> 'version')::SMALLINT, 1),
        COALESCE((v_summary ->> 'duration')::INTEGER, 0),
        COALESCE((v_summary ->> 'distance')::INTEGER, 0),
        COALESCE((v_summary ->> 'strokes')::INTEGER, 0),
        NULLIF((v_summary ->> 'calories'), '')::INTEGER,
        NULLIF((v_summary ->> 'avgSpm'),   '')::NUMERIC,
        NULLIF((v_summary ->> 'avgPace'),  '')::INTEGER,
        NULLIF((v_summary ->> 'avgWatts'), '')::INTEGER,
        NULLIF((v_summary ->> 'avgHr'),    '')::INTEGER
    );

    FOR v_sample IN SELECT * FROM jsonb_array_elements(data -> 'samples') LOOP
        v_idx := v_idx + 1;
        INSERT INTO xesync.workout_strokes (
            workout_id, stroke_number, time_sec, distance_m,
            spm, watts, heartrate, pace_sec
        ) VALUES (
            workout,
            COALESCE((v_sample ->> 2)::INTEGER, v_idx),
            (v_sample ->> 0)::NUMERIC,
            (v_sample ->> 1)::INTEGER,
            (v_sample ->> 3)::NUMERIC,
            (v_sample ->> 4)::INTEGER,
            NULLIF((v_sample ->> 5), '')::INTEGER,
            (v_sample ->> 6)::INTEGER
        )
        ON CONFLICT (workout_id, stroke_number) DO NOTHING;
    END LOOP;

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
EXCEPTION
    WHEN OTHERS THEN
        RETURN QUERY SELECT 'error'::TEXT, ('Failed to process workout: ' || SQLERRM)::TEXT;
END;
$$;


-- ============================================================================
-- LIST WORKOUTS
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.list_workouts(token TEXT)
RETURNS TABLE (
    workout_id      TEXT,
    workout_date    TIMESTAMPTZ,
    duration_sec    INTEGER,
    distance_m      INTEGER,
    total_strokes   INTEGER,
    calories        INTEGER,
    avg_spm         NUMERIC,
    avg_pace_sec    INTEGER,
    avg_watts       INTEGER,
    avg_hr          INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
BEGIN
    v_user_id := xesync.user_id_from_token(token);
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        w.workout_id::TEXT,
        w.workout_date,
        w.duration_sec,
        w.distance_m,
        w.total_strokes,
        w.calories,
        w.avg_spm,
        w.avg_pace_sec,
        w.avg_watts,
        w.avg_hr
    FROM xesync.workouts w
    WHERE w.user_id = v_user_id
    ORDER BY w.workout_date DESC;
END;
$$;


-- ============================================================================
-- RAW FTMS LOGGING (debug)
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.log_rawdata(date TEXT, data TEXT)
RETURNS TABLE (status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
BEGIN
    INSERT INTO xesync.ftms_rawdata (insert_date, raw_data)
    VALUES (to_timestamp(date, 'DD/MM/YYYY HH24:MI:SS.MS'), data);
    RETURN QUERY SELECT 'ok'::TEXT;
EXCEPTION
    WHEN OTHERS THEN
        RETURN QUERY SELECT 'error'::TEXT;
END;
$$;


-- ============================================================================
-- PERMISSIONS
-- ============================================================================

GRANT USAGE ON SCHEMA xesync TO web_anon;

REVOKE ALL ON FUNCTION xesync.login(TEXT, TEXT)               FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.validate_token(TEXT)            FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.save_workout(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.list_workouts(TEXT)             FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.log_rawdata(TEXT, TEXT)         FROM PUBLIC;

GRANT EXECUTE ON FUNCTION xesync.login(TEXT, TEXT)               TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.validate_token(TEXT)            TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.save_workout(TEXT, TEXT, JSONB) TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.list_workouts(TEXT)             TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.log_rawdata(TEXT, TEXT)         TO web_anon;

REVOKE ALL ON FUNCTION xesync.create_user(TEXT, TEXT)    FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.reset_password(TEXT, TEXT) FROM PUBLIC;