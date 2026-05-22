// XeSync configuration
var XESYNC_CONFIG = {
  // Base URL for the PostgREST API.
  // Nginx proxies /api/ → http://127.0.0.1:3000 (PostgREST).
  // RPC endpoints under /api/rpc/{login,validate_token,save_workout,log_rawdata}.
  apiBaseUrl: 'https://xesync.enlistia.com/api',

  // Full URL of the home page (loaded in iframe after login).
  // Replace with whatever you want to show after login, or set to '' to skip.
  apexHomeUrl: 'https://xesync.enlistia.com/home.html',

  // Send every FTMS packet to /rpc/log_rawdata for debugging.
  // Leave false in prod — at ~2 req/sec per user it adds a lot of noise.
  logRawData: false
};