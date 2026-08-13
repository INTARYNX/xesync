// =====================================================================
// harness.js - loads ftms_integration.js into a controlled sandbox.
//
// The module is a browser IIFE that talks to window/document and reads
// Date.now() directly, so testing it means supplying those rather than
// refactoring the module to be importable. Everything here is a stub with
// exactly enough behaviour for the code paths under test:
//
//   - a fake clock, so inactivity/pause timing is deterministic instead of
//     depending on real elapsed milliseconds;
//   - a fake DOM where getElementById() always returns an element, so
//     setText() writes somewhere readable and the pause-dialog code doesn't
//     null-deref;
//   - a captured setInterval, so the inactivity watchdog is driven by the
//     test rather than by the event loop.
// =====================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'ftms_integration.js');

// -- fake clock --------------------------------------------------------
function makeClock(startMs) {
  let now = startMs;

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }

  return {
    Date: FakeDate,
    advance(ms) { now += ms; },
    now() { return now; }
  };
}

// -- fake DOM ----------------------------------------------------------
function makeElement(id) {
  const el = {
    id,
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    style: { cssText: '' },
    children: [],
    classes: new Set()
  };
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    contains: (c) => el.classes.has(c)
  };
  el.appendChild = (child) => { el.children.push(child); return child; };
  el.removeChild = (child) => {
    const i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    return child;
  };
  el.insertAdjacentHTML = () => {};
  Object.defineProperty(el, 'firstChild', {
    get: () => el.children[0] || null
  });
  return el;
}

function makeDocument() {
  // Every id resolves to a stable element. The module only ever creates
  // elements it then looks up by id, so this models it faithfully enough
  // while letting tests read rendered values back out.
  const byId = new Map();
  const body = makeElement('body');

  const doc = {
    body,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement(id));
      return byId.get(id);
    },
    createElement(tag) { return makeElement('<' + tag + '>'); },
    addEventListener() {}
  };
  doc._text = (id) => doc.getElementById(id).textContent;
  doc._visible = (id) => doc.getElementById(id).classes.has('visible');
  return doc;
}

// -- loader ------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {string} [opts.search] querystring, e.g. '?debug=true'
 * @param {number} [opts.startMs] initial clock value
 */
function loadFtms(opts) {
  opts = opts || {};
  const clock = makeClock(opts.startMs === undefined ? 1700000000000 : opts.startMs);
  const document = makeDocument();
  const intervals = [];

  const window = {
    location: { search: opts.search || '', hash: '' }
  };

  const sandbox = {
    window,
    document,
    URLSearchParams,
    crypto,
    console,
    Date: clock.Date,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {}
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

  return {
    window,
    document,
    clock,
    api: {
      init:     window.initFtmsTracking,
      ingest:   window.ingestData,
      save:     window.saveWorkout,
      exit:     window.exitSession
    },
    internals: window.FtmsInternals,
    // Drive the inactivity watchdog by hand.
    tick() { intervals.forEach((i) => i.fn()); },
    tickIntervalMs() { return intervals.length ? intervals[0].ms : null; }
  };
}

// -- frame building ----------------------------------------------------
// Encodes back into the Xebex wire format: value = byte[hi] * 255 + byte[lo].
// Used to generate fixtures; the literal hand-checked frame lives in the
// test file so the encoder and decoder aren't validating each other alone.
function buildFrame(fields) {
  const b = new Array(20).fill(0);
  const put16 = (hi, lo, v) => {
    b[hi] = Math.floor(v / 255);
    b[lo] = v % 255;
  };

  b[2] = Math.round((fields.spm || 0) / 0.5);
  put16(4, 3, fields.strokes || 0);
  put16(6, 5, fields.distance || 0);
  put16(9, 8, fields.pace || 0);
  put16(11, 10, fields.watts || 0);
  put16(13, 12, fields.cals || 0);
  b[16] = fields.hr === undefined ? 255 : fields.hr;
  put16(19, 18, fields.elapsed || 0);

  return b.join(',');
}

module.exports = { loadFtms, buildFrame, makeClock, makeDocument };
