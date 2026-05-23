-- ============================================================================
-- XeSync — registration + email verification
-- Idempotent: safe to re-run.
--
-- Adds:
--   - email column on users
--   - email_queue table (cron worker picks unsent rows)
--   - pending_verifications table
--   - register(username, email, password) → queues verification email
--   - verify_email(token) → activates user
--   - resend_verification(email) → re-issues a token
-- ============================================================================

SET search_path TO xesync, public;

-- ── users: add email + active flag ──────────────────────────────────────────
ALTER TABLE xesync.users
    ADD COLUMN IF NOT EXISTS email           VARCHAR(255),
    ADD COLUMN IF NOT EXISTS email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE;

-- email unique (NULL allowed for legacy rows)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON xesync.users (lower(email)) WHERE email IS NOT NULL;


-- ── email_queue: outbox for the cron worker ─────────────────────────────────
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


-- ── pending_verifications: tokens awaiting click-through ────────────────────
CREATE TABLE IF NOT EXISTS xesync.pending_verifications (
    token       VARCHAR(64) PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES xesync.users(user_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_user ON xesync.pending_verifications (user_id);


-- ============================================================================
-- CONFIG (hard-coded — adapt to your site)
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


-- ============================================================================
-- HELPERS
-- ============================================================================

-- Build the verification email body
CREATE OR REPLACE FUNCTION xesync.build_verification_email(p_username TEXT, p_token TEXT)
RETURNS TEXT
LANGUAGE sql
AS $$
    SELECT
        'Hi ' || p_username || E',\n\n' ||
        'Welcome to XeSync. Confirm your email by visiting:\n\n' ||
        xesync.verify_url_base() || '?token=' || p_token || E'\n\n' ||
        'This link expires in ' || xesync.verify_ttl_hours() || E' hours.\n\n' ||
        'If you didn''t create this account, ignore this email.\n\n' ||
        '— XeSync';
$$;


-- ============================================================================
-- REGISTER
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.register(username TEXT, email TEXT, password TEXT)
RETURNS TABLE (status TEXT, error TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = xesync, public
AS $$
DECLARE
    v_user_id BIGINT;
    v_token   TEXT;
    v_clean_email TEXT;
    v_clean_username TEXT;
BEGIN
    -- Basic validation
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

    -- Uniqueness checks (race conditions guarded by unique indexes)
    IF EXISTS (SELECT 1 FROM xesync.users WHERE lower(user_name) = lower(v_clean_username)) THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Username already taken'::TEXT;
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM xesync.users WHERE lower(email) = v_clean_email) THEN
        RETURN QUERY SELECT 'error'::TEXT, 'Email already registered'::TEXT;
        RETURN;
    END IF;

    -- Create the user, inactive until they click the verification link
    INSERT INTO xesync.users (user_name, email, password_hash, email_verified, is_active)
    VALUES (
        v_clean_username,
        v_clean_email,
        crypt(password, gen_salt('bf', 10)),
        FALSE,
        FALSE
    )
    RETURNING user_id INTO v_user_id;

    -- Issue a verification token
    v_token := xesync.random_hex(64);
    INSERT INTO xesync.pending_verifications (token, user_id, expires_at)
    VALUES (v_token, v_user_id, now() + (xesync.verify_ttl_hours() || ' hours')::interval);

    -- Queue the email
    INSERT INTO xesync.email_queue (to_addr, subject, body)
    VALUES (
        v_clean_email,
        'Confirm your XeSync account',
        xesync.build_verification_email(v_clean_username, v_token)
    );

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
EXCEPTION
    WHEN OTHERS THEN
        RETURN QUERY SELECT 'error'::TEXT, ('Registration failed: ' || SQLERRM)::TEXT;
END;
$$;


-- ============================================================================
-- VERIFY EMAIL
-- ============================================================================

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
        DELETE FROM xesync.pending_verifications WHERE token = verify_email.token;
        RETURN QUERY SELECT 'error'::TEXT, NULL::TEXT, 'Token expired — request a new one'::TEXT;
        RETURN;
    END IF;

    UPDATE xesync.users
       SET email_verified = TRUE,
           is_active      = TRUE
     WHERE user_id = v_user_id
     RETURNING user_name INTO v_username;

    DELETE FROM xesync.pending_verifications WHERE token = verify_email.token;

    RETURN QUERY SELECT 'success'::TEXT, v_username, NULL::TEXT;
END;
$$;


-- ============================================================================
-- RESEND VERIFICATION
-- ============================================================================

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

    -- Don't reveal whether the address is registered or not
    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    -- Invalidate any previous pending tokens for this user
    DELETE FROM xesync.pending_verifications WHERE user_id = v_user_id;

    v_token := xesync.random_hex(64);
    INSERT INTO xesync.pending_verifications (token, user_id, expires_at)
    VALUES (v_token, v_user_id, now() + (xesync.verify_ttl_hours() || ' hours')::interval);

    INSERT INTO xesync.email_queue (to_addr, subject, body)
    VALUES (
        v_email,
        'Confirm your XeSync account',
        xesync.build_verification_email(v_username, v_token)
    );

    RETURN QUERY SELECT 'success'::TEXT, NULL::TEXT;
EXCEPTION
    WHEN OTHERS THEN
        RETURN QUERY SELECT 'error'::TEXT, ('Resend failed: ' || SQLERRM)::TEXT;
END;
$$;


-- ============================================================================
-- UPDATE login() TO BLOCK INACTIVE USERS
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


-- ============================================================================
-- WORKER HELPERS (called by the cron script — not exposed to web_anon)
-- ============================================================================

CREATE OR REPLACE FUNCTION xesync.email_queue_claim(p_max INTEGER DEFAULT 20)
RETURNS TABLE (id BIGINT, to_addr TEXT, subject TEXT, body TEXT)
LANGUAGE sql
AS $$
    SELECT id, to_addr::TEXT, subject, body
      FROM xesync.email_queue
     WHERE sent_at IS NULL
       AND attempts < 5
     ORDER BY created_at
     LIMIT p_max;
$$;

CREATE OR REPLACE FUNCTION xesync.email_queue_mark_sent(p_id BIGINT)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE xesync.email_queue
       SET sent_at = now(), last_error = NULL
     WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION xesync.email_queue_mark_failed(p_id BIGINT, p_error TEXT)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE xesync.email_queue
       SET attempts = attempts + 1,
           last_error = p_error
     WHERE id = p_id;
$$;


-- ============================================================================
-- PERMISSIONS
-- ============================================================================

REVOKE ALL ON FUNCTION xesync.register(TEXT, TEXT, TEXT)   FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.verify_email(TEXT)           FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.resend_verification(TEXT)    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION xesync.register(TEXT, TEXT, TEXT)   TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.verify_email(TEXT)           TO web_anon;
GRANT EXECUTE ON FUNCTION xesync.resend_verification(TEXT)    TO web_anon;

-- Worker helpers stay restricted (the cron script connects as a different role)
REVOKE ALL ON FUNCTION xesync.email_queue_claim(INTEGER)   FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.email_queue_mark_sent(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION xesync.email_queue_mark_failed(BIGINT, TEXT) FROM PUBLIC;