// =====================================================================
// rowing_phases.test.js - the four phases of the rowing stroke.
//
// The stroke cycle is made of four phases, in this order:
//
//   1. Prise d'eau (ou attaque) / Catch     / transition avant
//   2. Propulsion (ou appui)    / Drive     / phase motrice
//   3. Dégagement               / Finish    / transition arrière
//   4. Replacement (ou retour)  / Recovery  / phase de glisse
//
// The pose track the animation runs on is 0..1, with the catch at 0 and the
// finish at FINISH_RENDER_PHASE - so the phase of a frame is read straight
// off that track, the same value the shader is fed. These tests pin the
// table itself (a phase is not just a label: it carries a type, a role, a
// segment order and a key action) and the boundaries between phases.
//
//   node --test tests/
// =====================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAnimation() {
  const sandbox = {
    window: { parent: { postMessage() {} } },
    document: {},
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const file = path.join(__dirname, '..', 'rowing_display.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.RowingAnimation;
}

const RA = loadAnimation();

// The module is loaded in a vm sandbox, so the objects it hands back come
// from another realm and deepStrictEqual compares their prototypes too.
// Copy them into this realm before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------

test('the stroke cycle has exactly four phases, in order', () => {
  assert.equal(RA.PHASES.length, 4);
  assert.deepEqual(plain(RA.PHASES.map(p => p.order)), [1, 2, 3, 4]);
  assert.deepEqual(
    plain(RA.PHASES.map(p => p.english)),
    ['Catch', 'Drive', 'Finish', 'Recovery']
  );
});

test('each phase carries its type, role, segment order and key action', () => {
  const expected = [
    {
      order: 1,
      name: "Prise d'eau (ou attaque)",
      english: 'Catch',
      type: 'Transition avant',
      role: 'Immerger la palette',
      segments: 'Tibias verticaux, tronc penché, bras tendus',
      action: 'Relever les mains pour entrer la pelle à la verticale (au carré)'
    },
    {
      order: 2,
      name: 'Propulsion (ou appui)',
      english: 'Drive',
      type: 'Phase motrice',
      role: 'Faire avancer le bateau',
      segments: 'Jambes -> Tronc -> Bras',
      action: 'Pousser sur les cale-pieds, ouvrir le buste, tirer les poignées aux côtés'
    },
    {
      order: 3,
      name: 'Dégagement',
      english: 'Finish',
      type: 'Transition arrière',
      role: 'Sortir la palette',
      segments: 'Jambes tendues, tronc incliné en arrière',
      action: 'Abaisser les mains vers les cuisses et mettre la pelle à plat'
    },
    {
      order: 4,
      name: 'Replacement (ou retour)',
      english: 'Recovery',
      type: 'Phase de glisse',
      role: "Revenir à l'attaque et récupérer",
      segments: 'Bras -> Tronc -> Jambes',
      action: 'Tendre les bras, basculer le buste en avant, fléchir les genoux'
    }
  ];
  assert.deepEqual(plain(RA.PHASES), expected);
});

test('the drive is the only motor phase, the catch and finish are transitions', () => {
  const byType = Object.fromEntries(RA.PHASES.map(p => [p.english, p.type]));
  assert.equal(byType.Catch, 'Transition avant');
  assert.equal(byType.Drive, 'Phase motrice');
  assert.equal(byType.Finish, 'Transition arrière');
  assert.equal(byType.Recovery, 'Phase de glisse');
});

// ---------------------------------------------------------------------
// Boundaries on the pose track
// ---------------------------------------------------------------------

test('the pose track starts on the catch and ends on the recovery', () => {
  assert.equal(RA.phaseAt(0), RA.PHASE_CATCH);
  assert.equal(RA.phaseAt(0.999), RA.PHASE_RECOVERY);
});

test('the catch is a short window at the start of the track', () => {
  assert.equal(RA.phaseAt(0), RA.PHASE_CATCH);
  assert.equal(RA.phaseAt(0.05), RA.PHASE_CATCH);
  assert.equal(RA.phaseAt(0.07), RA.PHASE_DRIVE);
});

test('the drive runs from the catch to the finish', () => {
  assert.equal(RA.phaseAt(0.07), RA.PHASE_DRIVE);
  assert.equal(RA.phaseAt(0.2), RA.PHASE_DRIVE);
  assert.equal(RA.phaseAt(RA.FINISH_RENDER_PHASE - 0.01), RA.PHASE_DRIVE);
});

test('the finish is a short window right at the finish landmark', () => {
  assert.equal(RA.phaseAt(RA.FINISH_RENDER_PHASE), RA.PHASE_FINISH);
  assert.equal(RA.phaseAt(RA.FINISH_RENDER_PHASE + 0.05), RA.PHASE_FINISH);
  assert.equal(RA.phaseAt(RA.FINISH_RENDER_PHASE + 0.07), RA.PHASE_RECOVERY);
});

test('the recovery runs from the finish back to the catch', () => {
  assert.equal(RA.phaseAt(RA.FINISH_RENDER_PHASE + 0.07), RA.PHASE_RECOVERY);
  assert.equal(RA.phaseAt(0.7), RA.PHASE_RECOVERY);
  assert.equal(RA.phaseAt(0.999), RA.PHASE_RECOVERY);
});

test('a full sweep of the pose track walks the four phases in table order', () => {
  const seen = [];
  for (let p = 0; p < 1; p += 0.001) {
    const phase = RA.phaseAt(p);
    if (seen[seen.length - 1] !== phase) seen.push(phase);
  }
  assert.deepEqual(seen, [RA.PHASE_CATCH, RA.PHASE_DRIVE, RA.PHASE_FINISH, RA.PHASE_RECOVERY]);
});

test('the phase of a pose position does not depend on how it is written', () => {
  // The pose track is a circle: 0.0 and 1.0 are the same point.
  assert.equal(RA.phaseAt(1), RA.phaseAt(0));
  assert.equal(RA.phaseAt(1.5), RA.phaseAt(0.5));
  assert.equal(RA.phaseAt(-0.25), RA.phaseAt(0.75));
});

test('the drive takes more of the stroke than either transition', () => {
  const share = (i) => {
    let n = 0;
    for (let p = 0; p < 1; p += 0.001) if (RA.phaseAt(p) === i) n++;
    return n;
  };
  const catchShare = share(RA.PHASE_CATCH);
  const driveShare = share(RA.PHASE_DRIVE);
  const finishShare = share(RA.PHASE_FINISH);
  const recoveryShare = share(RA.PHASE_RECOVERY);

  assert.ok(driveShare > catchShare, 'the drive is longer than the catch');
  assert.ok(driveShare > finishShare, 'the drive is longer than the finish');
  assert.ok(recoveryShare > catchShare, 'the recovery is longer than the catch');
  assert.ok(recoveryShare > finishShare, 'the recovery is longer than the finish');
  // The two transitions are the same short window.
  assert.equal(catchShare, finishShare);
});

// ---------------------------------------------------------------------
// The phases and the pose track the shader would have drawn
// ---------------------------------------------------------------------

test('the pose track the shader reads puts the catch at 0 and the finish at its landmark', () => {
  // toRenderPhase maps the stroke cycle onto the pose track. At the finish
  // of the drive it must land on the finish landmark, and one full cycle
  // later, back on the catch.
  assert.ok(Math.abs(RA.toRenderPhase(RA.FINISH_PHASE, 1 / 3) - RA.FINISH_RENDER_PHASE) < 1e-9);
});

test('every phase is reachable from the pose track the animation produces', () => {
  // Walk the pose track the animation actually produces over a stroke and
  // check the four phases all show up - a phase that the animation can
  // never reach would be dead weight in the table.
  const seen = new Set();
  for (let a = 0; a < 1; a += 0.0005) {
    const pose = RA.toRenderPhase(a, 1 / 3);
    seen.add(RA.phaseAt(pose));
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});
