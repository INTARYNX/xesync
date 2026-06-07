// =====================================================================
// api.js - all network calls. Pure: takes args, returns a Promise that
// resolves to parsed data. No DOM, no state mutation, no side effects.
// =====================================================================

var Api = (function () {
  'use strict';

  function base() { return XESYNC_CONFIG.apiBaseUrl; }

  function post(path, body) {
    return fetch(base() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (arr) {
      return Array.isArray(arr) ? arr[0] : arr;  // PostgREST returns an array
    });
  }

  return {
    login: function (username, password) {
      return post('/rpc/login', { username: username, password: password });
    },
    register: function (username, email, password) {
      return post('/rpc/register', { username: username, email: email, password: password });
    },
    validateToken: function (token) {
      return post('/rpc/validate_token', { token: token });
    },
    saveWorkout: function (token, workout, data) {
      return post('/rpc/save_workout', { token: token, workout: workout, data: data });
    },
    logRawData: function (dateStr, data) {
      return post('/rpc/log_rawdata', { date: dateStr, data: data }).catch(function () {});
    }
  };
})();
