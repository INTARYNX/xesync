// =====================================================================
// debug.js - debug-build helpers. Lets the app run with no BLE/rower by
// faking scan results and a connection. Kept separate from production
// logic so it can be removed without touching the controller.
// =====================================================================

var Debug = (function () {
  'use strict';

  function isOn() { return ui.debug; }

  // Pretend a rower was found shortly after a scan starts.
  function fakeScan(onResult) {
    setTimeout(function () {
      onResult({ devices: [{ id: 'DE:BU:G0:00:01 Debug Rower' }] });
    }, 1200);
  }

  // Pretend the connection succeeded.
  function fakeConnect(onResult) {
    setTimeout(function () { onResult({ success: true }); }, 800);
  }

  function startSim() { DebugSim.reset(); DebugSim.start(); }
  function stopSim()  { DebugSim.stop(); }

  return { isOn: isOn, fakeScan: fakeScan, fakeConnect: fakeConnect, startSim: startSim, stopSim: stopSim };
})();
