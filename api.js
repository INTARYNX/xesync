// =====================================================================
// api.js - all network calls. Pure: takes args, returns a Promise that
// resolves to parsed data. No DOM, no state mutation, no side effects.
// =====================================================================

var Api = (function () {
  'use strict';

  function base() { return XESYNC_CONFIG.apiBaseUrl; }

  // Some RPCs return a set of rows rather than a single one. The
  // single-row helper above takes the first element, which would throw
  // the rest of the list away.
  function postRows(path, body) {
    return fetch(base() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (arr) {
      return Array.isArray(arr) ? arr : [];
    });
  }

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
    // The sessions, most recent first. The ghost picks its run from
    // these; get_workout then brings the samples of that one run.
    listWorkouts: function (token) {
      return postRows('/rpc/list_workouts', { token: token });
    },
    getWorkout: function (token, workout) {
      return post('/rpc/get_workout', { token: token, workout: workout });
    },
    // Debug-only, and token-gated server-side: ftms_rawdata rows are
    // attributed to the logged-in user, so an anonymous caller gets nothing.
    logRawData: function (token, dateStr, data) {
      return post('/rpc/log_rawdata', { token: token, date: dateStr, data: data })
        .catch(function () {});
    }
  };
})();
