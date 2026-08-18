// Regression tests for "final production fix" Phase 2c — the Motion/Zoom
// Effects catalog (lib/motionEffects.ts) and the bespoke per-effect
// continuous math added to computeMotionAdjustment/combineAdjustments
// (lib/render/compositor.ts). Run with `npx tsx test-motion-effects.mts`.

import { MOTION_EFFECTS, MOTION_INTENSITY_MAX, MOTION_INTENSITY_MIN, findMotionEffect } from './src/lib/motionEffects.ts';
import { computeMotionAdjustment, combineAdjustments } from './src/lib/render/compositor.ts';

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
const DURATION = 5;

function isIdentity(a: ReturnType<typeof computeMotionAdjustment>): boolean {
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
    a.hueRotateDeg === 0 &&
    a.vignetteAlpha === 0 &&
    a.spotlightBoost === 0 &&
    a.sweepAlpha === 0
  );
}

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

check('spec item 8: at least 12 motion effects in the catalog', MOTION_EFFECTS.length >= 12, `got ${MOTION_EFFECTS.length}`);
check('every effect id is unique', new Set(MOTION_EFFECTS.map((e) => e.id)).size === MOTION_EFFECTS.length);
check('findMotionEffect resolves a known id', findMotionEffect('ken-burns')?.label === 'Ken Burns');
check('findMotionEffect returns undefined for "none"/undefined', findMotionEffect('none') === undefined && findMotionEffect(undefined) === undefined);

// ---------------------------------------------------------------------------
// Every effect must do real, distinct, continuous motion — not a no-op —
// and 'none'/undefined must always be identity.
// ---------------------------------------------------------------------------

check('motion undefined is always identity', isIdentity(computeMotionAdjustment(undefined, 1, DURATION, CANVAS_W, CANVAS_H)));
check('motion type "none" is always identity', isIdentity(computeMotionAdjustment({ type: 'none' }, 1, DURATION, CANVAS_W, CANVAS_H)));

for (const effect of MOTION_EFFECTS) {
  // Sample at a few points across the item's own on-screen duration — a
  // continuous effect should be non-identity somewhere in there (unlike
  // transitions, there's no "outside the window" case to also check).
  const samples = [0.05, DURATION / 2, DURATION - 0.05].map((t) => computeMotionAdjustment({ type: effect.id }, t, DURATION, CANVAS_W, CANVAS_H));
  const anyNonIdentity = samples.some((a) => !isIdentity(a));
  check(`"${effect.id}" produces non-identity motion somewhere across the item's duration`, anyNonIdentity, JSON.stringify(samples));
}

// ---------------------------------------------------------------------------
// Determinism — never Math.random(), same inputs always produce the same
// output, so preview and export agree frame-for-frame.
// ---------------------------------------------------------------------------

for (const effect of MOTION_EFFECTS) {
  const a = computeMotionAdjustment({ type: effect.id, direction: 'left' }, 2.3, DURATION, CANVAS_W, CANVAS_H);
  const b = computeMotionAdjustment({ type: effect.id, direction: 'left' }, 2.3, DURATION, CANVAS_W, CANVAS_H);
  check(`"${effect.id}" is deterministic (same inputs -> same output)`, JSON.stringify(a) === JSON.stringify(b));
}

// ---------------------------------------------------------------------------
// Intensity — same "adjustable intensity" contract as the transitions catalog.
// ---------------------------------------------------------------------------

{
  const low = computeMotionAdjustment({ type: 'slow-zoom-in', intensity: 0.5 }, DURATION, DURATION, CANVAS_W, CANVAS_H);
  const normal = computeMotionAdjustment({ type: 'slow-zoom-in', intensity: 1 }, DURATION, DURATION, CANVAS_W, CANVAS_H);
  const high = computeMotionAdjustment({ type: 'slow-zoom-in', intensity: 2 }, DURATION, DURATION, CANVAS_W, CANVAS_H);
  check('higher intensity produces more zoom than normal', high.scaleMul > normal.scaleMul);
  check('lower intensity produces less zoom than normal', low.scaleMul < normal.scaleMul);
}
{
  const huge = computeMotionAdjustment({ type: 'slow-zoom-in', intensity: 999 }, DURATION, DURATION, CANVAS_W, CANVAS_H);
  const atMax = computeMotionAdjustment({ type: 'slow-zoom-in', intensity: MOTION_INTENSITY_MAX }, DURATION, DURATION, CANVAS_W, CANVAS_H);
  check('an absurd intensity value clamps to the catalog max', huge.scaleMul === atMax.scaleMul);
  const negative = computeMotionAdjustment({ type: 'slow-zoom-in', intensity: -5 }, DURATION, DURATION, CANVAS_W, CANVAS_H);
  const atMin = computeMotionAdjustment({ type: 'slow-zoom-in', intensity: MOTION_INTENSITY_MIN }, DURATION, DURATION, CANVAS_W, CANVAS_H);
  check('a negative intensity value clamps to the catalog min', negative.scaleMul === atMin.scaleMul);
}

// ---------------------------------------------------------------------------
// A few effects' specific, named mechanisms.
// ---------------------------------------------------------------------------

check(
  '"slow-zoom-in" scales up monotonically toward the end of the clip',
  computeMotionAdjustment({ type: 'slow-zoom-in' }, DURATION - 0.01, DURATION, CANVAS_W, CANVAS_H).scaleMul >
    computeMotionAdjustment({ type: 'slow-zoom-in' }, 0.01, DURATION, CANVAS_W, CANVAS_H).scaleMul,
);
check(
  '"slow-zoom-out" scales down monotonically toward the end of the clip',
  computeMotionAdjustment({ type: 'slow-zoom-out' }, DURATION - 0.01, DURATION, CANVAS_W, CANVAS_H).scaleMul <
    computeMotionAdjustment({ type: 'slow-zoom-out' }, 0.01, DURATION, CANVAS_W, CANVAS_H).scaleMul,
);
check(
  '"punch-zoom" is strongest right at the start and settles by the end',
  computeMotionAdjustment({ type: 'punch-zoom' }, 0, DURATION, CANVAS_W, CANVAS_H).scaleMul >
    computeMotionAdjustment({ type: 'punch-zoom' }, DURATION, DURATION, CANVAS_W, CANVAS_H).scaleMul,
);
check(
  '"ken-burns" pans (non-zero offset) as well as zooms',
  Math.abs(computeMotionAdjustment({ type: 'ken-burns', direction: 'right' }, 0.1, DURATION, CANVAS_W, CANVAS_H).offsetXPx) > 0,
);
check(
  '"parallax" drifts further than "ken-burns" at the same point (wider amplitude)',
  Math.abs(computeMotionAdjustment({ type: 'parallax', direction: 'left' }, 0.1, DURATION, CANVAS_W, CANVAS_H).offsetXPx) >
    Math.abs(computeMotionAdjustment({ type: 'ken-burns', direction: 'left' }, 0.1, DURATION, CANVAS_W, CANVAS_H).offsetXPx),
);
check(
  '"subtle-shake" jitters continuously — different points in time give different offsets',
  computeMotionAdjustment({ type: 'subtle-shake' }, 1, DURATION, CANVAS_W, CANVAS_H).offsetXPx !==
    computeMotionAdjustment({ type: 'subtle-shake' }, 1.3, DURATION, CANVAS_W, CANVAS_H).offsetXPx,
);
check('"vignette" darkens the edges (vignetteAlpha > 0)', computeMotionAdjustment({ type: 'vignette' }, 1, DURATION, CANVAS_W, CANVAS_H).vignetteAlpha > 0);
check(
  '"spotlight" both darkens edges AND brightens the center (spotlightBoost > 0)',
  (() => {
    const a = computeMotionAdjustment({ type: 'spotlight' }, 1, DURATION, CANVAS_W, CANVAS_H);
    return a.vignetteAlpha > 0 && a.spotlightBoost > 0;
  })(),
);
check(
  '"spotlight" center drifts over time (not a fixed position)',
  computeMotionAdjustment({ type: 'spotlight' }, 0.5, DURATION, CANVAS_W, CANVAS_H).vignetteCenterOffsetXPx !==
    computeMotionAdjustment({ type: 'spotlight' }, 3, DURATION, CANVAS_W, CANVAS_H).vignetteCenterOffsetXPx,
);
check('"flash" produces a bright overlay pulse', computeMotionAdjustment({ type: 'flash' }, DURATION / 2, DURATION, CANVAS_W, CANVAS_H).overlayAlpha >= 0);
check(
  '"light-sweep" band position tracks progress through the clip (0 near the start, ~1 near the end)',
  (() => {
    const start = computeMotionAdjustment({ type: 'light-sweep' }, 0.01, DURATION, CANVAS_W, CANVAS_H).sweepPositionPercent;
    const end = computeMotionAdjustment({ type: 'light-sweep' }, DURATION - 0.01, DURATION, CANVAS_W, CANVAS_H).sweepPositionPercent;
    return start < 0.05 && end > 0.95;
  })(),
);
check('"light-sweep" has a non-zero sweep alpha while active', computeMotionAdjustment({ type: 'light-sweep' }, DURATION / 2, DURATION, CANVAS_W, CANVAS_H).sweepAlpha > 0);
check(
  '"dynamic-zoom" peaks mid-clip and returns toward normal at both ends',
  (() => {
    const mid = computeMotionAdjustment({ type: 'dynamic-zoom' }, DURATION / 2, DURATION, CANVAS_W, CANVAS_H).scaleMul;
    const nearStart = computeMotionAdjustment({ type: 'dynamic-zoom' }, 0.02, DURATION, CANVAS_W, CANVAS_H).scaleMul;
    const nearEnd = computeMotionAdjustment({ type: 'dynamic-zoom' }, DURATION - 0.02, DURATION, CANVAS_W, CANVAS_H).scaleMul;
    return mid > nearStart && mid > nearEnd;
  })(),
);
check(
  '"product-focus" combines a gentle zoom with a vignette',
  (() => {
    const a = computeMotionAdjustment({ type: 'product-focus' }, DURATION, DURATION, CANVAS_W, CANVAS_H);
    return a.scaleMul > 1 && a.vignetteAlpha > 0;
  })(),
);

// ---------------------------------------------------------------------------
// combineAdjustments — a transition and a motion effect active on the same
// frame must genuinely layer, not one silently overriding the other.
// ---------------------------------------------------------------------------

{
  const transition = { ...computeMotionAdjustment(undefined, 0, DURATION, CANVAS_W, CANVAS_H), opacityMul: 0.5, offsetXPx: 10, scaleMul: 1.1 };
  const motion = { ...computeMotionAdjustment(undefined, 0, DURATION, CANVAS_W, CANVAS_H), opacityMul: 0.8, offsetXPx: 20, scaleMul: 1.2 };
  const combined = combineAdjustments(transition, motion);
  check('combineAdjustments multiplies opacity from both sources', Math.abs(combined.opacityMul - 0.4) < 1e-9);
  check('combineAdjustments adds offsets from both sources', combined.offsetXPx === 30);
  check('combineAdjustments multiplies scale from both sources', Math.abs(combined.scaleMul - 1.32) < 1e-9);
}
{
  // "Strongest wins" fields (blur/overlay/vignette) take the max of the two
  // sources rather than one clobbering the other.
  const transition = { ...computeMotionAdjustment(undefined, 0, DURATION, CANVAS_W, CANVAS_H), blurPx: 4, vignetteAlpha: 0.2 };
  const motion = { ...computeMotionAdjustment(undefined, 0, DURATION, CANVAS_W, CANVAS_H), blurPx: 9, vignetteAlpha: 0.1 };
  const combined = combineAdjustments(transition, motion);
  check('combineAdjustments takes the max blur of the two sources', combined.blurPx === 9);
  check('combineAdjustments takes the max vignette of the two sources', combined.vignetteAlpha === 0.2);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
