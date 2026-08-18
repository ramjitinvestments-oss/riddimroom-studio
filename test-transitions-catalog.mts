// Regression tests for "final production fix" Phase 2a — the expanded
// premium transitions catalog (lib/transitions.ts) and the bespoke
// per-preset math added to computeEntranceExit (lib/render/compositor.ts)
// to back it. Run with `npx tsx test-transitions-catalog.mts`.

import {
  TRANSITION_CATEGORIES,
  TRANSITION_PRESETS,
  TRANSITION_INTENSITY_MIN,
  TRANSITION_INTENSITY_MAX,
  findTransitionPreset,
  transitionPresetsByCategory,
} from './src/lib/transitions.ts';
import { computeEntranceExit } from './src/lib/render/compositor.ts';

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}${detail ? ' -- ' + detail : ''}`);
    failed++;
  }
}

const CANVAS_W = 1080;
const CANVAS_H = 1920;

function isIdentity(a: ReturnType<typeof computeEntranceExit>): boolean {
  return (
    a.opacityMul === 1 &&
    a.offsetXPx === 0 &&
    a.offsetYPx === 0 &&
    a.scaleMul === 1 &&
    a.blurPx === 0 &&
    a.overlayAlpha === 0 &&
    a.skewX === 0 &&
    a.scaleXMul === 1 &&
    a.scaleYMul === 1 &&
    a.rotationDeltaDeg === 0 &&
    a.hueRotateDeg === 0
  );
}

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

check('spec item 7 minimum: at least 25 transition presets in the catalog', TRANSITION_PRESETS.length >= 25, `got ${TRANSITION_PRESETS.length}`);
check('preferred: at least 28 transition presets in the catalog', TRANSITION_PRESETS.length >= 28, `got ${TRANSITION_PRESETS.length}`);
check('exactly 4 named categories', TRANSITION_CATEGORIES.length === 4);
check(
  'category ids match spec section names (clean/modern/cinematic/marketing)',
  TRANSITION_CATEGORIES.map((c) => c.id).sort().join(',') === 'cinematic,clean,marketing,modern',
);
check('every preset id is unique', new Set(TRANSITION_PRESETS.map((p) => p.id)).size === TRANSITION_PRESETS.length);
check('every preset has a positive default duration', TRANSITION_PRESETS.every((p) => p.defaultDurationSeconds > 0));
check(
  'every category has at least 6 presets (roughly even spread, not lopsided)',
  TRANSITION_CATEGORIES.every((cat) => transitionPresetsByCategory(cat.id).length >= 6),
);
check('findTransitionPreset resolves a known id', findTransitionPreset('fade')?.category === 'clean');
check('findTransitionPreset returns undefined for an unknown/undefined id', findTransitionPreset(undefined) === undefined);

// ---------------------------------------------------------------------------
// Bespoke math — every catalog preset must actually do something (real,
// distinct motion), not silently fall through to the identity adjustment,
// and must resolve back to identity well outside its animation window.
// ---------------------------------------------------------------------------

for (const preset of TRANSITION_PRESETS) {
  const nearStart = computeEntranceExit(preset.id, 0.02, 100, 10, CANVAS_W, CANVAS_H);
  check(`"${preset.id}" produces non-identity adjustment near an item's start (entrance)`, !isIdentity(nearStart), JSON.stringify(nearStart));

  const wellInside = computeEntranceExit(preset.id, 100, 100, 210, CANVAS_W, CANVAS_H);
  check(`"${preset.id}" is back to identity well outside its animation window`, isIdentity(wellInside), JSON.stringify(wellInside));
}

check('"none" is always the identity adjustment', isIdentity(computeEntranceExit('none', 0, 100, 10, CANVAS_W, CANVAS_H)));
check('undefined preset is always the identity adjustment', isIdentity(computeEntranceExit(undefined, 0, 100, 10, CANVAS_W, CANVAS_H)));

// Independent-object guarantee (see IDENTITY_ADJUSTMENT's own doc comment
// in compositor.ts — a shared-by-reference identity previously corrupted
// every subsequent item that hit the fast path).
{
  const a = computeEntranceExit('none', 0, 100, 10, CANVAS_W, CANVAS_H);
  a.opacityMul = 0;
  const b = computeEntranceExit('none', 0, 100, 10, CANVAS_W, CANVAS_H);
  check('mutating one identity result does not corrupt a later call (transitions catalog presets)', b.opacityMul === 1);
}

// ---------------------------------------------------------------------------
// Intensity — spec item 7's "adjustable intensity" requirement.
// ---------------------------------------------------------------------------

{
  const low = computeEntranceExit('slide-left', 0.05, 100, 10, CANVAS_W, CANVAS_H, 0.5);
  const normal = computeEntranceExit('slide-left', 0.05, 100, 10, CANVAS_W, CANVAS_H, 1);
  const high = computeEntranceExit('slide-left', 0.05, 100, 10, CANVAS_W, CANVAS_H, 2);
  check('higher intensity produces a larger displacement than normal', Math.abs(high.offsetXPx) > Math.abs(normal.offsetXPx));
  check('lower intensity produces a smaller displacement than normal', Math.abs(low.offsetXPx) < Math.abs(normal.offsetXPx));
}
{
  // Out-of-range intensity values (corrupt/legacy saved data) must clamp,
  // not blow up into an unusable (inverted/absurd) transition.
  const huge = computeEntranceExit('zoom', 0.05, 100, 10, CANVAS_W, CANVAS_H, 999);
  const atMax = computeEntranceExit('zoom', 0.05, 100, 10, CANVAS_W, CANVAS_H, TRANSITION_INTENSITY_MAX);
  check('an absurd intensity value clamps to the catalog max rather than exploding the math', huge.scaleMul === atMax.scaleMul);
  const negative = computeEntranceExit('zoom', 0.05, 100, 10, CANVAS_W, CANVAS_H, -5);
  const atMin = computeEntranceExit('zoom', 0.05, 100, 10, CANVAS_W, CANVAS_H, TRANSITION_INTENSITY_MIN);
  check('a negative intensity value clamps to the catalog min rather than inverting the motion', negative.scaleMul === atMin.scaleMul);
}

// ---------------------------------------------------------------------------
// A few presets' specific, named mechanisms (not just "isn't identity").
// ---------------------------------------------------------------------------

check('"dip-to-black" uses a black overlay wash', computeEntranceExit('dip-to-black', 0.01, 100, 10, CANVAS_W, CANVAS_H).overlayColor === '#000000');
check('"dip-to-white" uses a white overlay wash', computeEntranceExit('dip-to-white', 0.01, 100, 10, CANVAS_W, CANVAS_H).overlayColor === '#ffffff');
check(
  '"flash" overlay is strongest at the very first instant and fades out',
  (() => {
    const first = computeEntranceExit('flash', 0.0, 100, 10, CANVAS_W, CANVAS_H).overlayAlpha;
    const later = computeEntranceExit('flash', 0.2, 100, 10, CANVAS_W, CANVAS_H).overlayAlpha;
    return first > later;
  })(),
);
check('"spin" rotates (non-zero rotationDeltaDeg near entrance)', Math.abs(computeEntranceExit('spin', 0.02, 100, 10, CANVAS_W, CANVAS_H).rotationDeltaDeg) > 10);
check('"flip" starts edge-on — scaleXMul near 0 at the very first instant of entrance', computeEntranceExit('flip', 0.0, 100, 10, CANVAS_W, CANVAS_H).scaleXMul < 0.1);
check('"skew" shears (non-zero skewX)', Math.abs(computeEntranceExit('skew', 0.02, 100, 10, CANVAS_W, CANVAS_H).skewX) > 0);
check('"rainbow" hue-rotates', Math.abs(computeEntranceExit('rainbow', 0.02, 100, 10, CANVAS_W, CANVAS_H).hueRotateDeg) > 10);
check(
  '"whip-pan" combines large offset with heavy blur',
  (() => {
    const a = computeEntranceExit('whip-pan', 0.02, 100, 10, CANVAS_W, CANVAS_H);
    return Math.abs(a.offsetXPx) > 50 && a.blurPx > 5;
  })(),
);
check(
  '"shake" is deterministic — same inputs always produce the same output (no Math.random)',
  JSON.stringify(computeEntranceExit('shake', 0.1, 100, 10, CANVAS_W, CANVAS_H)) === JSON.stringify(computeEntranceExit('shake', 0.1, 100, 10, CANVAS_W, CANVAS_H)),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
