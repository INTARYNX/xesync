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
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    email            VARCHAR(255),
    email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_users_token
    ON xesync.users (user_token) WHERE user_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON xesync.users (lower(email)) WHERE email IS NOT NULL;


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


-- Verbatim archive of every accepted save_workout() payload, kept so a
-- parsing change can be replayed against real submissions.
--
-- user_id/workout_id are populated only for rows written after the
-- authentication fix; pre-existing rows were inserted before the caller was
-- identified at all and are left NULL rather than guessed at. That is also
-- why user_id is nullable - the column cannot be NOT NULL without
-- destroying that history.
CREATE TABLE IF NOT EXISTS xesync.workout_data (
    id          BIGSERIAL PRIMARY KEY,
    data        JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE xesync.workout_data
    ADD COLUMN IF NOT EXISTS user_id BIGINT
    REFERENCES xesync.users(user_id) ON DELETE CASCADE;

ALTER TABLE xesync.workout_data
    ADD COLUMN IF NOT EXISTS workout_id VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_workout_data_user ON xesync.workout_data (user_id);


-- Debug capture of raw FTMS frames. Written only by log_rawdata(), which
-- requires a valid session token - see the note on that function.
CREATE TABLE IF NOT EXISTS xesync.ftms_rawdata (
    id           BIGSERIAL PRIMARY KEY,
    insert_date  TIMESTAMPTZ NOT NULL,
    raw_data     TEXT        NOT NULL
);

ALTER TABLE xesync.ftms_rawdata
    ADD COLUMN IF NOT EXISTS user_id BIGINT
    REFERENCES xesync.users(user_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ftms_rawdata_user ON xesync.ftms_rawdata (user_id);


CREATE TABLE IF NOT EXISTS xesync.email_queue (
    id          BIGSERIAL PRIMARY KEY,
    to_addr     VARCHAR(255) NOT NULL,
    subject     TEXT         NOT NULL,
    body        TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ,
    last_error  TEXT,
    attempts    INTEGER      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending
    ON xesync.email_queue (created_at) WHERE sent_at IS NULL;


CREATE TABLE IF NOT EXISTS xesync.pending_verifications (
    token       VARCHAR(64) PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES xesync.users(user_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_user ON xesync.pending_verifications (user_id);

-- ============================================================================
-- ACCOUNT MANAGEMENT
--   - request_password_reset(email)            → public, queues email
--   - reset_password_with_token(token, pwd)    → public, consumes token
--   - change_password(token, old_pwd, new_pwd) → logged-in
--   - delete_account(token, password)          → logged-in
-- ============================================================================

-- Re-use pending_verifications table style but separate for clarity
CREATE TABLE IF NOT EXISTS xesync.pending_resets (
    token       VARCHAR(64) PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES xesync.users(user_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_resets_user ON xesync.pending_resets (user_id);

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
-- CONFIG
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.verify_url_base() RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT 'https://xesync.enlistia.com/verify.html';
$$;

CREATE OR REPLACE FUNCTION xesync.verify_ttl_hours() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT 24;
$$;

CREATE OR REPLACE FUNCTION xesync.email_from() RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT 'XeSync <noreply@enlistia.com>';
$$;

-- Upload limits. The client samples at most once a second and caps itself at
-- 15000 samples; these sit above that so a legitimate long session is never
-- rejected, while a crafted payload can't be used to write unbounded rows.
CREATE OR REPLACE FUNCTION xesync.max_workout_samples() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT 20000;
$$;

-- ~2MB of JSON. A 15000-sample payload is well under 1MB.
CREATE OR REPLACE FUNCTION xesync.max_workout_bytes() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT 2097152;
$$;

CREATE OR REPLACE FUNCTION xesync.build_verification_email(p_username TEXT, p_token TEXT)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT
        'Hi ' || p_username || ',' || chr(10) || chr(10) ||
        'Welcome to XeSync. Confirm your email by visiting:' || chr(10) || chr(10) ||
        xesync.verify_url_base() || '?token=' || p_token || chr(10) || chr(10) ||
        'This link expires in ' || xesync.verify_ttl_hours() || ' hours.' || chr(10) || chr(10) ||
        'If you didn''t create this account, ignore this email.' || chr(10) || chr(10) ||
        '— XeSync';
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
    v_active  BOOLEAN;
    v_token   TEXT;
BEGIN
    IF username IS NULL OR password IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, NULL::TEXT, 'Missing username or password'::TEXT;
        RETURN;
    END IF;

    SELECT u.user_id, u.password_hash, u.is_active
      INTO v_user_id, v_hash, v_active
      FROM xesync.users u
     WHERE lower(u.user_name) = lower(username);

    IF v_user_id IS NULL OR v_hash IS NULL OR crypt(password, v_hash) <> v_hash THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, NULL::TEXT, 'Invalid username or password'::TEXT;
        RETURN;
    END IF;

    IF NOT v_active THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, NULL::TEXT, 'Please verify your email first'::TEXT;
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
-- REGISTRATION + EMAIL VERIFICATION
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.register(username TEXT, email TEXT, password TEXT)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id        BIGINT;
    v_token          TEXT;
    v_clean_email    TEXT;
    v_clean_username TEXT;
BEGIN
    IF username IS NULL OR email IS NULL OR password IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing fields'::TEXT;
        RETURN;
    END IF;

    v_clean_username := trim(username);
    v_clean_email    := lower(trim(email));

    IF length(v_clean_username) < 3 THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Username must be at least 3 characters'::TEXT;
        RETURN;
    END IF;
    IF v_clean_username ~ '\s' THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Username cannot contain spaces'::TEXT;
        RETURN;
    END IF;
    IF length(password) < 8 THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Password must be at least 8 characters'::TEXT;
        RETURN;
    END IF;
    IF v_clean_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Invalid email address'::TEXT;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM xesync.users u WHERE lower(u.user_name) = lower(v_clean_username)) THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Username already taken'::TEXT;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM xesync.users u WHERE lower(u.email) = v_clean_email) THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Email already registered'::TEXT;
        RETURN;
    END IF;

    INSERT INTO xesync.users (user_name, email, password_hash, email_verified, is_active)
    VALUES (
        v_clean_username,
        v_clean_email,
        crypt(password, gen_salt('bf', 10)),
        FALSE,
        FALSE
    )
    RETURNING user_id INTO v_user_id;

    v_token := xesync.random_hex(64);
    INSERT INTO xesync.pending_verifications (token, user_id, expires_at)
    VALUES (v_token, v_user_id, now() + (xesync.verify_ttl_hours() || ' hours')::interval);

    INSERT INTO xesync.email_queue (to_addr, subject, body)
    VALUES (
        v_clean_email,
        'Confirm your XEsync account',
        xesync.build_verification_email(v_clean_username, v_token)
    );

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
EXCEPTION
    -- The EXISTS checks above are advisory only - two concurrent
    -- registrations for the same name/email both pass them and race to the
    -- INSERT. The unique constraint on user_name and the unique lower(email)
    -- index are what actually guarantee uniqueness; this turns the loser of
    -- that race into the same clean message the pre-check would have given,
    -- instead of a raw constraint-violation string.
    WHEN unique_violation THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Username or email already registered'::TEXT;
    WHEN OTHERS THEN
        -- SQLERRM used to be returned to the caller here, exposing internal
        -- column, constraint and statement detail to an unauthenticated
        -- endpoint. It belongs in the server log only.
        RAISE WARNING 'register failed for %: %', v_clean_username, SQLERRM;
        RETURN QUERY SELECT 'error'::TEXT, 'Registration failed'::TEXT;
END;
$$;


CREATE OR REPLACE FUNCTION xesync.verify_email(token TEXT)
RETURNS TABLE (status TEXT, username TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id  BIGINT;
    v_expires  TIMESTAMPTZ;
    v_username TEXT;
BEGIN
    IF token IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, 'Missing token'::TEXT;
        RETURN;
    END IF;

    SELECT pv.user_id, pv.expires_at
      INTO v_user_id, v_expires
      FROM xesync.pending_verifications pv
     WHERE pv.token = verify_email.token;

    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, 'Invalid or already-used token'::TEXT;
        RETURN;
    END IF;

    IF v_expires < now() THEN
        DELETE FROM xesync.pending_verifications pv WHERE pv.token = verify_email.token;
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, 'Token expired — request a new one'::TEXT;
        RETURN;
    END IF;

    UPDATE xesync.users
       SET email_verified = TRUE,
           is_active      = TRUE
     WHERE user_id = v_user_id
     RETURNING user_name INTO v_username;

    DELETE FROM xesync.pending_verifications pv WHERE pv.token = verify_email.token;

    RETURN QUERY SELECT 'success'::TEXT, v_username, NULL::TEXT;
END;
$$;


CREATE OR REPLACE FUNCTION xesync.resend_verification(email TEXT)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id  BIGINT;
    v_username TEXT;
    v_email    TEXT;
    v_token    TEXT;
BEGIN
    IF email IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing email'::TEXT;
        RETURN;
    END IF;

    v_email := lower(trim(email));

    SELECT u.user_id, u.user_name INTO v_user_id, v_username
      FROM xesync.users u
     WHERE lower(u.email) = v_email
       AND u.email_verified = FALSE;

    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    DELETE FROM xesync.pending_verifications WHERE user_id = v_user_id;

    v_token := xesync.random_hex(64);
    INSERT INTO xesync.pending_verifications (token, user_id, expires_at)
    VALUES (v_token, v_user_id, now() + (xesync.verify_ttl_hours() || ' hours')::interval);

    INSERT INTO xesync.email_queue (to_addr, subject, body)
    VALUES (
        v_email,
        'Confirm your XEsync account',
        xesync.build_verification_email(v_username, v_token)
    );

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
EXCEPTION
    WHEN OTHERS THEN
        RETURN QUERY SELECT 'error'::TEXT, ('Resend failed: ' || SQLERRM)::TEXT;
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

    INSERT INTO xesync.users (user_name, password_hash, is_active)
    VALUES (trim(p_username), crypt(p_password, gen_salt('bf', 10)), TRUE)
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
    v_samples INTEGER;
BEGIN
    IF token IS NULL OR workout IS NULL OR data IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing token, workout or data'::TEXT;
        RETURN;
    END IF;

    -- AUTHENTICATE FIRST. Nothing above this point writes.
    --
    -- This used to INSERT the submitted JSON into workout_data before
    -- resolving the token, which made the RPC an unauthenticated write:
    -- anyone who could reach PostgREST could grow that table without ever
    -- holding an account. Every write below is now behind a resolved user.
    v_user_id := xesync.user_id_from_token(token);
    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Invalid or expired token'::TEXT;
        RETURN;
    END IF;

    IF length(workout) > 50 THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Workout id too long'::TEXT;
        RETURN;
    END IF;

    -- Bound the payload before doing any per-sample work, so an oversized
    -- submission costs one length check rather than N inserts.
    IF length(data::TEXT) > xesync.max_workout_bytes() THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Workout payload too large'::TEXT;
        RETURN;
    END IF;

    -- IS DISTINCT FROM, not <>: jsonb_typeof() returns SQL NULL when the key
    -- is absent entirely, and a plain <> would evaluate to NULL and fall
    -- through instead of rejecting.
    IF jsonb_typeof(data -> 'samples') IS DISTINCT FROM 'array'
       OR jsonb_typeof(data -> 'summary') IS DISTINCT FROM 'object' THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Malformed workout payload'::TEXT;
        RETURN;
    END IF;

    v_samples := jsonb_array_length(data -> 'samples');
    IF v_samples > xesync.max_workout_samples() THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Too many samples'::TEXT;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM xesync.workouts WHERE workout_id = workout) THEN
        RETURN QUERY SELECT 'success'::TEXT, 'Data already processed'::TEXT;
        RETURN;
    END IF;

    INSERT INTO xesync.workout_data(user_id, workout_id, data)
    VALUES (v_user_id, workout, data);

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
    WHEN unique_violation THEN
        -- Concurrent duplicate upload of the same workout id; the row the
        -- other call inserted is authoritative and equivalent.
        RETURN QUERY SELECT 'success'::TEXT, 'Data already processed'::TEXT;
    WHEN OTHERS THEN
        -- SQLERRM goes to the server log, never to the client: it can carry
        -- column names, constraint names and fragments of the statement.
        RAISE WARNING 'save_workout failed for user % workout %: %',
            v_user_id, workout, SQLERRM;
        RETURN QUERY SELECT 'error'::TEXT, 'Failed to process workout'::TEXT;
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

-- log_rawdata(date, data) - the original two-argument form - was SECURITY
-- DEFINER, granted to web_anon, with no token check anywhere in the body:
-- an unauthenticated, public, write-only endpoint into ftms_rawdata.
--
-- It is NOT dropped. The Capacitor build bakes api.js into the APK at
-- build time rather than fetching it from this server, so every app
-- version already installed from Google Play up to and including
-- versionCode 14 is running a frozen copy that calls exactly
-- log_rawdata(date, data) - no token, because that build predates one
-- existing. PostgREST resolves /rpc/log_rawdata by matching the JSON
-- body's keys against a function's parameter names, so dropping this
-- overload turns every call from an already-installed app into a
-- "function not found" error the moment this migration runs, not
-- whenever that user happens to update.
--
-- So the two-argument form stays, permanently reachable, but reduced to a
-- no-op: it accepts the call and reports success (matching what those
-- clients already expect, since the original call is wrapped in
-- `.catch(() => {})` and ignored either way) without writing anything an
-- anonymous caller supplied. That closes the actual hole - arbitrary
-- unauthenticated data no longer reaches the table - without changing
-- observable behaviour for any client that can't be made to send a token.
--
-- New clients (versionCode 15+) call the three-argument, token-checked
-- overload below instead; see api.js / controller.js.
CREATE OR REPLACE FUNCTION xesync.log_rawdata(date TEXT, data TEXT)
RETURNS TABLE (status TEXT)
LANGUAGE sql
AS $$
    SELECT 'ok'::TEXT;
$$;

CREATE OR REPLACE FUNCTION xesync.log_rawdata(token TEXT, date TEXT, data TEXT)
RETURNS TABLE (status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_ts      TIMESTAMPTZ;
BEGIN
    IF token IS NULL OR data IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT;
        RETURN;
    END IF;

    -- Authenticate before writing, same rule as save_workout().
    v_user_id := xesync.user_id_from_token(token);
    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT;
        RETURN;
    END IF;

    -- One frame is 20 values of at most 3 digits plus separators; anything
    -- an order of magnitude past that is not a frame.
    IF length(data) > 512 THEN
        RETURN QUERY SELECT 'error'::TEXT;
        RETURN;
    END IF;

    -- to_timestamp() raises on a badly-formed input rather than returning
    -- NULL, so COALESCE cannot cover this - it needs its own handler. For a
    -- debug capture, stamping now() beats discarding the frame over a
    -- device clock formatting quirk.
    BEGIN
        v_ts := to_timestamp(date, 'DD/MM/YYYY HH24:MI:SS.MS');
    EXCEPTION
        WHEN OTHERS THEN v_ts := now();
    END;
    IF v_ts IS NULL THEN v_ts := now(); END IF;

    INSERT INTO xesync.ftms_rawdata (user_id, insert_date, raw_data)
    VALUES (v_user_id, v_ts, data);

    RETURN QUERY SELECT 'ok'::TEXT;
EXCEPTION
    WHEN OTHERS THEN
        RETURN QUERY SELECT 'error'::TEXT;
END;
$$;


-- ============================================================================
-- WORKER HELPERS (cron script only — not exposed to web_anon)
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.email_queue_claim(p_max INTEGER DEFAULT 20)
RETURNS TABLE (id BIGINT, to_addr TEXT, subject TEXT, body TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
    SELECT id, to_addr::TEXT, subject, body
      FROM xesync.email_queue
     WHERE sent_at IS NULL
       AND attempts < 5
     ORDER BY created_at
     LIMIT p_max;
$$;

CREATE OR REPLACE FUNCTION xesync.email_queue_mark_sent(p_id BIGINT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
    UPDATE xesync.email_queue
       SET sent_at = now(), last_error = NULL
     WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION xesync.email_queue_mark_failed(p_id BIGINT, p_error TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
    UPDATE xesync.email_queue
       SET attempts = attempts + 1,
           last_error = p_error
     WHERE id = p_id;
$$;


-- ============================================================================
-- GET WORKOUT DETAIL
-- Returns the full sample list for a single workout owned by the token's user.
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.get_workout(token TEXT, workout TEXT)
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
    avg_hr          INTEGER,
    samples         JSONB
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
        w.avg_hr,
        COALESCE(
          (SELECT jsonb_agg(jsonb_build_array(
              s.time_sec, s.distance_m, s.spm, s.watts, s.heartrate, s.pace_sec
            ) ORDER BY s.stroke_number)
           FROM xesync.workout_strokes s
           WHERE s.workout_id = w.workout_id),
          '[]'::jsonb
        ) AS samples
    FROM xesync.workouts w
    WHERE w.user_id    = v_user_id
      AND w.workout_id = get_workout.workout;
END;
$$;


CREATE OR REPLACE FUNCTION xesync.reset_url_base() RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT 'https://xesync.enlistia.com/reset_password.html';
$$;

CREATE OR REPLACE FUNCTION xesync.reset_ttl_hours() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT 1;
$$;

CREATE OR REPLACE FUNCTION xesync.build_reset_email(p_username TEXT, p_token TEXT)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT
        'Hi ' || p_username || ',' || chr(10) || chr(10) ||
        'A password reset was requested for your XEsync account. To set a new password, visit:' || chr(10) || chr(10) ||
        xesync.reset_url_base() || '?token=' || p_token || chr(10) || chr(10) ||
        'This link expires in ' || xesync.reset_ttl_hours() || ' hour(s).' || chr(10) || chr(10) ||
        'If you didn''t request this, ignore this email — your password is unchanged.' || chr(10) || chr(10) ||
        '— XeSync';
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- Request a password reset. Always returns success (does not leak whether the
-- email is registered).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION xesync.request_password_reset(email TEXT)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id  BIGINT;
    v_username TEXT;
    v_email    TEXT;
    v_token    TEXT;
BEGIN
    IF email IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing email'::TEXT;
        RETURN;
    END IF;

    v_email := lower(trim(email));

    SELECT u.user_id, u.user_name INTO v_user_id, v_username
      FROM xesync.users u
     WHERE lower(u.email) = v_email
       AND u.is_active = TRUE;

    IF v_user_id IS NULL THEN
        -- Silent success: don't reveal whether the address is registered
        RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    DELETE FROM xesync.pending_resets WHERE user_id = v_user_id;

    v_token := xesync.random_hex(64);
    INSERT INTO xesync.pending_resets (token, user_id, expires_at)
    VALUES (v_token, v_user_id, now() + (xesync.reset_ttl_hours() || ' hours')::interval);

    INSERT INTO xesync.email_queue (to_addr, subject, body)
    VALUES (
        v_email,
        'Reset your XEsync password',
        xesync.build_reset_email(v_username, v_token)
    );

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
EXCEPTION
    WHEN OTHERS THEN
        RETURN QUERY SELECT 'error'::TEXT, ('Reset request failed: ' || SQLERRM)::TEXT;
END;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- Consume a reset token to set a new password. Single-use; deletes the token.
-- Also invalidates any existing session token (forces re-login).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION xesync.reset_password_with_token(token TEXT, new_password TEXT)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_expires TIMESTAMPTZ;
BEGIN
    IF token IS NULL OR new_password IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing token or password'::TEXT;
        RETURN;
    END IF;
    IF length(new_password) < 8 THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Password must be at least 8 characters'::TEXT;
        RETURN;
    END IF;

    SELECT pr.user_id, pr.expires_at
      INTO v_user_id, v_expires
      FROM xesync.pending_resets pr
     WHERE pr.token = reset_password_with_token.token;

    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Invalid or already-used token'::TEXT;
        RETURN;
    END IF;

    IF v_expires < now() THEN
        DELETE FROM xesync.pending_resets pr WHERE pr.token = reset_password_with_token.token;
        RETURN QUERY SELECT 'error'::TEXT, 'Token expired — request a new one'::TEXT;
        RETURN;
    END IF;

    UPDATE xesync.users
       SET password_hash = crypt(new_password, gen_salt('bf', 10)),
           user_token    = NULL,
           token_expiry  = NULL
     WHERE user_id = v_user_id;

    DELETE FROM xesync.pending_resets pr WHERE pr.token = reset_password_with_token.token;

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
END;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- Change password while logged in. Requires the current password.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION xesync.change_password(token TEXT, old_password TEXT, new_password TEXT)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_hash    TEXT;
BEGIN
    IF token IS NULL OR old_password IS NULL OR new_password IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing fields'::TEXT;
        RETURN;
    END IF;
    IF length(new_password) < 8 THEN
        RETURN QUERY SELECT 'error'::TEXT, 'New password must be at least 8 characters'::TEXT;
        RETURN;
    END IF;

    SELECT u.user_id, u.password_hash INTO v_user_id, v_hash
      FROM xesync.users u
     WHERE u.user_token   = change_password.token
       AND u.token_expiry > now();

    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Invalid or expired token'::TEXT;
        RETURN;
    END IF;

    IF crypt(old_password, v_hash) <> v_hash THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Current password is incorrect'::TEXT;
        RETURN;
    END IF;

    UPDATE xesync.users
       SET password_hash = crypt(new_password, gen_salt('bf', 10))
     WHERE user_id = v_user_id;

    -- Keep the current session valid (don't force re-login)

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
END;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- Permanently delete the account and all associated data. Requires password.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION xesync.delete_account(token TEXT, password TEXT)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_hash    TEXT;
BEGIN
    IF token IS NULL OR password IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Missing fields'::TEXT;
        RETURN;
    END IF;

    SELECT u.user_id, u.password_hash INTO v_user_id, v_hash
      FROM xesync.users u
     WHERE u.user_token   = delete_account.token
       AND u.token_expiry > now();

    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Invalid or expired token'::TEXT;
        RETURN;
    END IF;

    IF crypt(password, v_hash) <> v_hash THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Password is incorrect'::TEXT;
        RETURN;
    END IF;

    -- ON DELETE CASCADE will clean up workouts, strokes, pending_*, etc.
    DELETE FROM xesync.users WHERE user_id = v_user_id;

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
END;
$$;


-- ============================================================================
-- DATA EXPORT (GDPR art. 20 — right to data portability)
-- Returns the full account data + all workouts as a single JSON blob.
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.export_account(token TEXT)
RETURNS TABLE (status TEXT, data JSONB, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_data    JSONB;
BEGIN
    v_user_id := xesync.user_id_from_token(token);
    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'error'::TEXT, NULL::JSONB, 'Invalid or expired token'::TEXT;
        RETURN;
    END IF;

    SELECT jsonb_build_object(
        'exported_at', now(),
        'account', (
            SELECT jsonb_build_object(
                'username',       u.user_name,
                'email',          u.email,
                'email_verified', u.email_verified,
                'created_at',     u.created_at,
                'last_connection', u.last_connection
            )
            FROM xesync.users u WHERE u.user_id = v_user_id
        ),
        'workouts', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'workout_id',    w.workout_id,
                'workout_date',  w.workout_date,
                'duration_sec',  w.duration_sec,
                'distance_m',    w.distance_m,
                'total_strokes', w.total_strokes,
                'calories',      w.calories,
                'avg_spm',       w.avg_spm,
                'avg_pace_sec',  w.avg_pace_sec,
                'avg_watts',     w.avg_watts,
                'avg_hr',        w.avg_hr,
                'samples', COALESCE(
                  (SELECT jsonb_agg(jsonb_build_array(
                      s.time_sec, s.distance_m, s.spm, s.watts, s.heartrate, s.pace_sec
                    ) ORDER BY s.stroke_number)
                   FROM xesync.workout_strokes s
                   WHERE s.workout_id = w.workout_id),
                  '[]'::jsonb
                )
            ) ORDER BY w.workout_date DESC)
            FROM xesync.workouts w WHERE w.user_id = v_user_id
        ), '[]'::jsonb)
    ) INTO v_data;

    RETURN QUERY SELECT 'success'::TEXT, v_data, NULL::TEXT;
END;
$$;

-- ============================================================================
-- PERMISSIONS
--
-- Default-deny. PostgreSQL grants EXECUTE on every new function to PUBLIC
-- automatically, and PostgREST turns anything web_anon can execute into a
-- public /rpc/ endpoint. Enumerating functions to revoke one by one means a
-- helper added later is exposed by default until someone remembers to add a
-- line here - which is exactly what had happened to user_id_from_token(),
-- a SECURITY DEFINER token->user_id lookup that was reachable as
-- /rpc/user_id_from_token because it appeared in no REVOKE list.
--
-- So: strip everything first, then grant back only the intended API surface.
-- A new function is closed until it is named below.
-- ============================================================================

GRANT USAGE ON SCHEMA xesync TO web_anon;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA xesync FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA xesync FROM web_anon;

-- No direct table access: web_anon reaches data only through the SECURITY
-- DEFINER functions below, which is what makes the token checks inside them
-- the only way in.
REVOKE ALL ON ALL TABLES IN SCHEMA xesync FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA xesync FROM web_anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA xesync FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA xesync FROM web_anon;

-- Keep the deny-by-default stance for objects created after this script runs.
ALTER DEFAULT PRIVILEGES IN SCHEMA xesync REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- ── Public API surface (PostgREST /rpc/*) ───────────────────────────────
-- Unauthenticated by nature: they establish or recover an identity.
GRANT EXECUTE ON FUNCTION xesync.register(TEXT, TEXT, TEXT)             TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.login(TEXT, TEXT)                      TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.verify_email(TEXT)                     TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.resend_verification(TEXT)              TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.request_password_reset(TEXT)           TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.reset_password_with_token(TEXT, TEXT)  TO web_anon;

-- Token-authenticated: each verifies the token itself before doing anything.
GRANT EXECUTE ON FUNCTION xesync.validate_token(TEXT)                   TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.save_workout(TEXT, TEXT, JSONB)        TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.list_workouts(TEXT)                    TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.get_workout(TEXT, TEXT)                TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.change_password(TEXT, TEXT, TEXT)      TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.delete_account(TEXT, TEXT)             TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.export_account(TEXT)                   TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.log_rawdata(TEXT, TEXT, TEXT)          TO web_anon;

-- Legacy no-op, kept reachable only so pre-token app builds (Play Store
-- versionCode <= 14) get their existing 'ok' response instead of a
-- PostgREST "function not found" error. Writes nothing. Safe to drop once
-- no installed app older than the token-aware log_rawdata build remains -
-- check Play Console's version distribution before removing.
GRANT EXECUTE ON FUNCTION xesync.log_rawdata(TEXT, TEXT)                TO web_anon;

-- Deliberately NOT granted to web_anon, and listed here so their absence is
-- a decision rather than an oversight:
--   user_id_from_token   - internal auth helper
--   create_user          - admin/bootstrap
--   reset_password       - admin, no token required
--   email_queue_claim / _mark_sent / _mark_failed - cron worker only; the
--     xesync_worker role gets these explicitly in worker/setup_worker.sh,
--     and the REVOKEs above target only PUBLIC and web_anon so re-running
--     this file does not strip them
--   random_hex, build_*_email, and the *_ttl/*_url/max_* config helpers


-- ── Verification ────────────────────────────────────────────────────────
-- After running this file, this should return exactly the granted list
-- above and nothing else:
--
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'xesync'
--      AND has_function_privilege('web_anon', p.oid, 'EXECUTE')
--    ORDER BY 1, 2;
--
-- And this should return zero rows - nothing in the schema reachable by
-- PUBLIC, which every role inherits:
--
--   SELECT p.proname
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'xesync'
--      AND has_function_privilege('public', p.oid, 'EXECUTE')
--    ORDER BY 1;



