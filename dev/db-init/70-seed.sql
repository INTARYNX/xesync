-- =====================================================================
-- E2E fixture user for Playwright's DB-integration spec.
--
-- Inserted directly rather than through xesync.register(), because
-- register() queues a real verification email and leaves email_verified
-- false until that link is clicked - there is no mail server in this
-- stack (worker/mail_worker.py needs real SMTP) to complete that flow.
-- Login and everything downstream of it still runs through the real
-- xesync.login()/xesync.save_workout() functions; only account creation
-- is short-circuited.
--
-- Credentials also live in tests/e2e/fixtures.js - keep the two in sync.
-- =====================================================================

INSERT INTO xesync.users (user_name, email, password_hash, email_verified, is_active)
VALUES (
    'e2e_test_user',
    'e2e@xesync.test',
    crypt('E2eTestPass123!', gen_salt('bf', 10)),
    TRUE,
    TRUE
)
ON CONFLICT (user_name) DO NOTHING;
