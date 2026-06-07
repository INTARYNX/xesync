# XEsync - App Inventor (AI2) blocks

The native Android app is the BLE bridge between the Xebex rower and the
WebView running the web app. It speaks to the web app through two channels:

- **out** (AI2 -> web): set `WebViewerMain.WebViewString` to a JSON string,
  then call `RunJavaScript("handleAppResponse(AppInventor.getWebViewString())")`.
- **in** (web -> AI2): the `WebViewerMain.WebViewStringChange` event fires;
  the block reads the `action` key and dispatches.

All messages are JSON objects with an `action` field.

## Global variables

| Variable | Init | Purpose |
|----------|------|---------|
| `url` | `file:///android_asset/app.html?id=` + random | WebView home URL (cache-bust) |
| `Devices` | empty list | scan working list |
| `BleMac` | empty | MAC of the connected/target rower |
| `serviceUuid` | `00001826-...` | FTMS service UUID |
| `characteristicUuid` | `00002ad1-...` | FTMS characteristic UUID |
| `processedData` / `newData` / `previousData` | empty | FTMS frame de-duplication |
| `FilteredList` / `FoundDevices` / `XebexDevices` | empty list | scan filtering |
| `varToken` | empty | auth token from web app |
| `intentionalDisconnect` | `false` | distinguishes a user-requested disconnect from a real drop |

## Screen init

`Screen1.Initialize`:
- set WebView home URL, keep screen on, hide system bars
- `BluetoothStream.ConnectionTimeout = 1000`
- `BluetoothScan.ConnectionTimeout = 3000`

`ClockInit.Timer` (one-shot): bind `WebViewExtra` to the WebView, disable
zoom controls, then disable itself.

## Messages: web app -> AI2

Handled in `WebViewerMain.WebViewStringChange` by reading `action`:

| action | AI2 does |
|--------|----------|
| `scan` | `startScanning` (clears lists, `BluetoothScan.StartScanning`) |
| `connect` | set `BleMac` from `deviceId`, `BluetoothStream.ConnectWithAddress` |
| `disconnect` | set `intentionalDisconnect = true`, `BluetoothStream.Disconnect` |
| `reconnect` | `BluetoothStream.ConnectWithAddress(BleMac)` (one attempt; the web app drives the retry loop) |
| `exit` | `close application` |
| `stopScan` | `BluetoothScan.StopScanning` |
| `saveData` | `TinyDB.StoreValue(tag: "workout"+id, data)`, reply `{"action":"saveAck"}` |
| `uploadWorkout` | not received from web; see auto-login upload below |
| `uploadAck` | `TinyDB.ClearTag(workout)`, reply `{"action":"tagCleared","workout":...}` |

### Auto-login + offline upload (on `WebViewerMain.PageLoaded`)

- If `TinyDB.GetValue("token")` is non-empty, send
  `{"action":"autoLogin","token":<token>}` to the web app.
- On `loginResult success:true`, store the token, then for each TinyDB tag
  starting with `workout`, send
  `{"action":"uploadWorkout","token":...,"workout":<tag>,"data":<stored>}`
  so the web app can flush offline-saved workouts. Each successful upload
  comes back as `uploadAck` and the tag is cleared.
- On `loginResult` without success, clear the stored token.

## Messages: AI2 -> web app

| event | message sent |
|-------|--------------|
| `BluetoothStream.Connected` | `{"action":"connectResult","success":true}` |
| `BluetoothStream.Disconnected` (real drop) | `{"action":"disconnected"}` |
| `BluetoothStream.ConnectionFailed` | `{"action":"disconnected"}` |
| `BluetoothStream.BytesReceived` | `{"action":"ftmsData","data":<csv>}` |
| `BluetoothScan` device found / connected | builds `{"action":"scanResult","devices":[...]}` |

## BLE connect / data

`BluetoothStream.Connected`:
- `AutoReconnect = false` (the web app, not AI2, owns reconnection)
- `RegisterForBytes(serviceUuid, characteristicUuid, signed:false)`
- send `connectResult success:true`

`BluetoothStream.BytesReceived`:
- if `IsDeviceConnected`, read `byteValues` into `newData`
- if `newData != previousData`, update `previousData`, strip the framing
  bytes, and send `{"action":"ftmsData","data":<csv>}`

## Disconnect handling (manual vs real drop)

This is the key interaction with the web app's reconnect flow.

`disconnect` message (user tapped DISCONNECT/EXIT in the web app):
```
set intentionalDisconnect = true
BluetoothStream.Disconnect          // fires Disconnected below
```

`BluetoothStream.Disconnected`:
```
AutoReconnect = false
DisconnectWithAddress(BleMac)        // both Stream and Scan
if intentionalDisconnect == true
  then intentionalDisconnect = false           // user-requested: stay silent
  else send {"action":"disconnected"}          // real drop: tell the web app
```

`BluetoothStream.ConnectionFailed`:
```
send {"action":"disconnected"}        // also treated as a drop
```

Result:
- **Manual disconnect** -> flag is set -> `Disconnected` stays silent ->
  no RECONNECTING overlay. The web app already navigated away on the tap.
- **Real drop** (rower off / out of range) -> flag is false ->
  `Disconnected` (or `ConnectionFailed`) sends `disconnected` -> the web app
  shows RECONNECTING and drives up to 3 `reconnect` attempts, 5s apart.
- **Reconnect success** -> `Connected` fires -> `connectResult success:true`
  -> the web app cancels its timer and resumes the live session.

## Scan / device filtering

`startScanning`: clear `FoundDevices` / `FilteredList` / `XebexDevices`,
`BluetoothScan.StartScanning`.

`BluetoothScan.DeviceFound` / `ConnectionFailed`: split the device list and
call `CheckDevice`.

`CheckDevice`: take the first device, extract its name; if it contains
`XEBEX`, add its MAC to `FilteredList` / `FoundDevices` and connect via
`BluetoothScan.ConnectWithAddress`. On `BluetoothScan.Connected`, read the
supported characteristics, build a JSON array of `{id: <mac>}` for the
filtered devices, and send `{"action":"scanResult","devices":[...]}`.

## Notes / gotchas

- Keep `AutoReconnect = false` everywhere. AI2's native auto-reconnect
  would fight the web app's reconnect loop (double attempts).
- `RegisterForBytes` must run on every (re)connect inside `Connected`,
  otherwise no FTMS frames arrive after a reconnection.
- The FTMS frame is sent as a comma-separated byte string; the web app
  parses it (Xebex uses `high*255 + low`, not little-endian `*256`).
