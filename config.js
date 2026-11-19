// XeSync configuration
var XESYNC_CONFIG = {
  // Base URL for the PostgREST API.
  // Nginx proxies /api/ → http://127.0.0.1:3000 (PostgREST).
  // RPC endpoints under /api/rpc/{login,validate_token,save_workout,log_rawdata}.
  apiBaseUrl: 'https://xesync.intarynx.com/api',

  // Full URL of the home page (loaded in iframe after login).
  // Replace with whatever you want to show after login, or set to '' to skip.
  apexHomeUrl: 'https://xesync.intarynx.com/home.html',

  // Send every FTMS packet to /rpc/log_rawdata for debugging.
  // Leave false in prod — at ~2 req/sec per user it adds a lot of noise.
  logRawData: false,

  // Which renderer the rowing scene uses:
  //   'webgl'  - the real GLSL scene. Default, and what ships.
  //   'phases' - the shader-free stand-in: the same stroke cycle, tracker and
  //              pose track, drawn as the four phases of the stroke instead
  //              of pixels. The test build uses it (tests/e2e/build-app.js),
  //              where the fragment shader is too expensive to run without a
  //              GPU and starves the event loop.
  renderMode: 'webgl',

  // Shown on the login screen and useful in bug reports. Must match
  // capacitor/android/app/build.gradle's versionName — bump both together
  // on every release, there is no build step that syncs them automatically.
  appVersion: '2.06'
};