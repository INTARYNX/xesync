// XeSync configuration
var XESYNC_CONFIG = {
  // Base URL for the APEX REST endpoints (login, validate_token, workout, rawdata)
  apexBaseUrl: 'https://www.fournier-digital.ch/apex/mintaka/xesync',

  // Full URL of the APEX home page (loaded in iframe after login)
  apexHomeUrl: 'https://www.fournier-digital.ch/apex/r/mintaka/xesync/home',

  // Send every FTMS packet to /rawdata for debugging. Leave false in prod —
  // at ~2 req/sec per user it eats the APEX free tier rate limit fast.
  logRawData: false
};