# XEsync API

REST API served by PostgREST in front of a PostgreSQL schema. All endpoints are
plain JSON over HTTPS.

- **Base URL:** `https://xesync.enlistia.com/api`
- **Content-Type:** `application/json` (request and response)
- **Auth:** opaque bearer token returned by `/rpc/login`, passed as a field in
  the JSON body of subsequent calls (no `Authorization` header).
- **PostgREST version:** 12.x

All RPC calls are `POST` to `/rpc/<function_name>` with a JSON body whose keys
match the function's parameter names. Every function returns a JSON array
(possibly with a single element) — PostgREST behavior.

---

## Status / Error model

Most functions return rows shaped like:

```json
[ { "status": "success", "error": null,  ... } ]
[ { "status": "error",   "error": "Invalid username or password" } ]
```

- `status` is always `"success"` or `"error"`.
- On error, `error` contains a human-readable message.
- HTTP status is `200` even on logical errors — check the `status` field.
- HTTP `4xx` / `5xx` only occur for malformed requests, missing functions, or
  unhandled DB exceptions (PostgREST error envelope).

---

## Endpoints

### `POST /rpc/register`

Creates an inactive account and queues a verification email. The account
cannot log in until the user clicks the link in the email.

**Request**
```json
{
  "username": "alice",
  "email":    "alice@example.com",
  "password": "at-least-8-chars"
}
```

**Response — success**
```json
[ { "status": "success", "error": null } ]
```

**Response — error**
```json
[ { "status": "error", "error": "Email already registered" } ]
```

**Validation rules**
- `username` ≥ 3 chars, no whitespace, case-insensitive unique
- `email` matches `^[^@\s]+@[^@\s]+\.[^@\s]+$`, case-insensitive unique
- `password` ≥ 8 chars

---

### `POST /rpc/verify_email`

Consumes a verification token, activates the account, and deletes the token.
Tokens expire after 24 hours.

**Request**
```json
{ "token": "d26fb180955cf723f429f06abdbac2f481366dae483e92eafd6f78c2cfc3cd59" }
```

**Response — success**
```json
[ { "status": "success", "username": "alice", "error": null } ]
```

**Response — error**
```json
[ { "status": "error", "username": null, "error": "Invalid or already-used token" } ]
[ { "status": "error", "username": null, "error": "Token expired — request a new one" } ]
```

---

### `POST /rpc/resend_verification`

Re-issues a verification token for an unverified account. Always returns
success — does not reveal whether the address is registered.

**Request**
```json
{ "email": "alice@example.com" }
```

**Response**
```json
[ { "status": "success", "error": null } ]
```

---

### `POST /rpc/login`

Authenticates a user and returns a session token valid for 30 days.

**Request**
```json
{ "username": "alice", "password": "secret123" }
```

**Response — success**
```json
[
  {
    "status":       "success",
    "token":        "ab1974e2d4abd12d5248dd82dd9ccecf68036aa4e6453431980098ca9c4e95e7",
    "username_out": "alice",
    "error":        null
  }
]
```

**Response — error**
```json
[ { "status": "error", "token": null, "username_out": null, "error": "Invalid username or password" } ]
[ { "status": "error", "token": null, "username_out": null, "error": "Please verify your email first" } ]
```

The token replaces any previous one for the same user.

---

### `POST /rpc/validate_token`

Confirms a token is still valid and extends its expiry by 30 days. Used by the
app on startup to skip the login screen.

**Request**
```json
{ "token": "ab1974e2..." }
```

**Response — success**
```json
[ { "status": "success", "username": "alice", "error": null } ]
```

**Response — error**
```json
[ { "status": "error", "username": null, "error": "Invalid or expired token" } ]
```

---

### `POST /rpc/save_workout`

Persists a completed workout: summary row plus per-second samples.

**Request**
```json
{
  "token":   "ab1974e2...",
  "workout": "workout_20260523_184412",
  "data": {
    "version": 1,
    "summary": {
      "duration": 1820,
      "distance": 5012,
      "strokes":  412,
      "calories": 287,
      "avgSpm":   24.5,
      "avgPace":  108,
      "avgWatts": 145,
      "avgHr":    142
    },
    "samples": [
      [time, distance, strokes, spm, watts, hr, pace],
      ...
    ]
  }
}
```

**Sample tuple positions**

| Index | Field      | Type      | Notes                           |
|-------|------------|-----------|---------------------------------|
| 0     | `time`     | number    | seconds since start             |
| 1     | `distance` | int       | meters since start              |
| 2     | `strokes`  | int       | cumulative stroke count         |
| 3     | `spm`      | number    | strokes per minute              |
| 4     | `watts`    | int       | instantaneous power             |
| 5     | `hr`       | int/null  | heart rate, `null` if no belt   |
| 6     | `pace`     | int       | seconds per 500 m               |

**Response — success**
```json
[ { "status": "success", "error": null } ]
[ { "status": "success", "error": "Data already processed" } ]
```

Re-posting the same `workout` ID is safe: the call returns success without
duplicating rows. The raw payload is always logged to `xesync.workout_data`
before any validation.

**Response — error**
```json
[ { "status": "error", "error": "Invalid or expired token" } ]
[ { "status": "error", "error": "Failed to process workout: ..." } ]
```

---

### `POST /rpc/list_workouts`

Returns all workouts for the token's user, newest first.

**Request**
```json
{ "token": "ab1974e2..." }
```

**Response**
```json
[
  {
    "workout_id":    "workout_20260523_184412",
    "workout_date":  "2026-05-23T18:44:12+02:00",
    "duration_sec":  1820,
    "distance_m":    5012,
    "total_strokes": 412,
    "calories":      287,
    "avg_spm":       24.5,
    "avg_pace_sec":  108,
    "avg_watts":     145,
    "avg_hr":        142
  },
  ...
]
```

Returns an empty array if the token is invalid (no error).

---

### `POST /rpc/log_rawdata`

Debug endpoint for raw FTMS frames. Stores them verbatim with a timestamp.

**Request**
```json
{
  "date": "23/05/2026 18:44:12.123",
  "data": "02 1c 00 4d 01 ..."
}
```

**Response**
```json
[ { "status": "ok" } ]
[ { "status": "error" } ]
```

---

## Examples (curl)

**Register**
```bash
curl -X POST https://xesync.enlistia.com/api/rpc/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"secret123"}'
```

**Login**
```bash
curl -X POST https://xesync.enlistia.com/api/rpc/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
```

**Save a workout**
```bash
curl -X POST https://xesync.enlistia.com/api/rpc/save_workout \
  -H 'Content-Type: application/json' \
  -d @workout.json
```

**List workouts**
```bash
curl -X POST https://xesync.enlistia.com/api/rpc/list_workouts \
  -H 'Content-Type: application/json' \
  -d '{"token":"ab1974e2..."}'
```

---

## Security notes

- All functions are `SECURITY DEFINER` and run as the schema owner.
- The `web_anon` role used by PostgREST has `EXECUTE` only on the public-facing
  functions, no direct table access.
- Passwords are stored as bcrypt hashes (`crypt(..., gen_salt('bf', 10))`).
- Tokens are 64-char hex strings from `gen_random_bytes()`; each login
  invalidates the previous token for the same user.
- Email verification tokens expire after 24 hours and are single-use.
- `resend_verification` does not leak account existence.

## Internal functions (not exposed via PostgREST)

These exist in the `xesync` schema but are restricted to admin or worker roles:

- `xesync.create_user(username, password)` — admin user creation, bypasses email verification.
- `xesync.reset_password(username, password)` — admin password reset.
- `xesync.email_queue_claim(max)` / `email_queue_mark_sent(id)` / `email_queue_mark_failed(id, error)` — used by the mail worker via a dedicated `xesync_worker` DB role.