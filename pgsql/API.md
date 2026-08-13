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

Persists a completed workout: summary row plus samples.

Samples are recorded at **at most** 1 Hz — the client drops any frame arriving
less than a second after the last one it kept, so spacing follows BLE packet
timing and is not a fixed interval. Treat `time` as authoritative, not the row
index.

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
duplicating rows.

**Order of operations.** The token is resolved *before anything is written*.
The raw payload used to be inserted into `xesync.workout_data` ahead of the
token check, which made this an unauthenticated write; it is now archived
there only after authentication succeeds, tagged with `user_id` and
`workout_id`.

**Limits.** A payload over 2 MB, or carrying more than 20 000 samples, is
rejected outright. `data.summary` must be an object and `data.samples` an
array.

**Response — error**
```json
[ { "status": "error", "error": "Invalid or expired token" } ]
[ { "status": "error", "error": "Workout payload too large" } ]
[ { "status": "error", "error": "Too many samples" } ]
[ { "status": "error", "error": "Malformed workout payload" } ]
[ { "status": "error", "error": "Failed to process workout" } ]
```

Error strings are fixed. Internal `SQLERRM` detail is written to the server
log via `RAISE WARNING` and never returned to the caller.

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

Debug endpoint for raw FTMS frames. Stores them verbatim with a timestamp,
attributed to the calling user.

**Requires a valid token.** This was previously unauthenticated — a public
write-only endpoint into `ftms_rawdata`. It now resolves the token before
writing, and rejects frames longer than 512 characters.

Off by default in the client; `logRawData` in `config.js` gates it.

**Request**
```json
{
  "token": "5c3f...",
  "date": "23/05/2026 18:44:12.123",
  "data": "02 1c 00 4d 01 ..."
}
```

**Response**
```json
[ { "status": "ok" } ]
[ { "status": "error" } ]
```

`error` is deliberately opaque: an invalid token, an oversized frame and a
malformed timestamp are indistinguishable to the caller.

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

- All functions are `SECURITY DEFINER` and run as the schema owner, each with
  an explicit `SET search_path = xesync, public`.
- Permissions are **default-deny**: the schema revokes `EXECUTE` on all
  functions from `PUBLIC` and `web_anon`, then grants back only the endpoints
  documented above. PostgreSQL grants `EXECUTE` to `PUBLIC` on every new
  function automatically, and PostgREST exposes anything `web_anon` can
  execute — so an allowlist is the only arrangement where adding a helper
  doesn't silently publish it. (`user_id_from_token` had been exposed this
  way.)
- `web_anon` has no direct table or sequence access; the token checks inside
  the functions are the only path to data.
- Every endpoint that writes resolves its token *before* the first write.
- Passwords are stored as bcrypt hashes (`crypt(..., gen_salt('bf', 10))`).
- Tokens are 64-char hex strings from `gen_random_bytes()`; each login
  invalidates the previous token for the same user.
- Email verification tokens expire after 24 hours and are single-use.
- `resend_verification` does not leak account existence.

## Versioning policy

There are two things that version independently, not four. The DB schema is
an implementation detail nobody outside this repo ever sees; the JS web app
is baked into the APK at Capacitor build time (`capacitor/build-capacitor.ps1`
copies it into `www/`, not fetched from this server at runtime), so its
version is always identical to whatever APK shipped it. What's actually left:

- **The client** — one Android `versionCode`/`versionName`
  (`capacitor/android/app/build.gradle`), distributed via Google Play.
  Nobody can be made to update. A user can sit on any past build
  indefinitely — disabled auto-update, an old device that never opens the
  app, a staged rollout they never received. Treat every `versionCode` ever
  shipped as still live, forever, unless proven otherwise (Play
  Console → Statistics → version distribution is the actual source of
  truth for "still live").
- **The server** — this API + the schema behind it. Deployed whenever *we*
  choose, via `pgsql/migrate.sh`. This is the only side with a real release
  button.

Because the client side can never be forced to catch up, **the server must
stay backward compatible with every RPC signature any shipped client still
calls** — indefinitely, or until Play Console shows the old version's
install base is gone. Concretely:

- **Additive change** (new optional param via a new overload, a brand new
  function): safe, ship freely.
- **Behavior change on an existing signature** (e.g. tightening validation):
  safe only if every input the old client could legitimately send still
  produces the response it already expects.
- **Destructive change** (removing/renaming a param, requiring something the
  old client never sends): never done by editing the function in place.
  Keep the old signature as a compatibility overload — see
  `xesync.log_rawdata(date, data)` in `xesync_schema.sql`, kept as a
  permanent no-op specifically because Capacitor builds up to
  `versionCode 14` call it with no token and always will, until every one
  of those installs is gone. `xesync.save_workout` never had to do this
  because its signature never changed — that's the easy case, not the
  general one.

Every schema change first runs against `dev/docker-compose.yml` (see the
README's Local database section) before touching production — that's what
turns "should be backward compatible" into something actually checked, not
just intended. `pgsql/migrate.sh`'s permission-surface check
(`EXPECTED_WEB_ANON_FUNCS`) is part of that: it fails loudly if a migration
silently changes what `web_anon` can reach, in either direction.

`config.js`'s `appVersion` (shown in the top bar) and
`build.gradle`'s `versionName` are two separate strings with no build step
that syncs them — bump both by hand on every release. It exists for
correlating a bug report to a build, not as an enforcement mechanism; there
is currently no server-side check that rejects an old client, by design —
only bumped for a real vulnerability if backward compatibility for the
security fix itself is impossible.

## Internal functions (not exposed via PostgREST)

These exist in the `xesync` schema but are restricted to admin or worker roles:

- `xesync.create_user(username, password)` — admin user creation, bypasses email verification.
- `xesync.reset_password(username, password)` — admin password reset.
- `xesync.email_queue_claim(max)` / `email_queue_mark_sent(id)` / `email_queue_mark_failed(id, error)` — used by the mail worker via a dedicated `xesync_worker` DB role.