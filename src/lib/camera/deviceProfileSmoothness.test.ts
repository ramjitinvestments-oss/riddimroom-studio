import { describe, it, expect } from 'vitest';
import {
  parseDeviceProfiles,
  provenSmoothnessSuggestion,
  qualityStepDown,
  serializeDeviceProfiles,
  upsertDeviceProfile,
  withTakeOutcome,
  SMOOTHNESS_SUGGESTION_TEXT,
  type DeviceProfile,
} from './deviceProfile';
import {
  buildCaptureReceipt,
  captureReceiptDropWarning,
  captureReceiptSmoothnessVerdict,
  formatCaptureReceipt,
} from './captureReceipt';

const BASE: DeviceProfile = { facing: 'environment', shortSideClass: '2160', fps: 60, mimeType: 'video/mp4' };

describe('withTakeOutcome — outcome recording (R36 WS-4)', () => {
  it('a take under the existing advisory threshold records smooth', () => {
    // 5 of 900 = 0.6% and under the 30-frame absolute arm.
    const p = withTakeOutcome(BASE, '4k', { droppedFrames: 5, expectedFrames: 900 });
    expect(p.lastTakeSmooth).toBe(true);
    expect(p.lastQuality).toBe('4k');
    expect(p.lastDroppedFrames).toBe(5);
    expect(p.lastExpectedFrames).toBe(900);
    // The input profile is not mutated.
    expect(BASE.lastTakeSmooth).toBeUndefined();
  });

  it('a take over the relative arm records not smooth (same threshold as the receipt advisory)', () => {
    // 9 of 90 = 10% > 2%.
    const p = withTakeOutcome(BASE, '4k', { droppedFrames: 9, expectedFrames: 90 });
    expect(p.lastTakeSmooth).toBe(false);
  });

  it('a take over the absolute arm records not smooth even at a tiny percentage', () => {
    const p = withTakeOutcome(BASE, 'auto', { droppedFrames: 40, expectedFrames: 100000 });
    expect(p.lastTakeSmooth).toBe(false);
  });

  it('an unmeasured take clears any previous verdict instead of leaving it stale', () => {
    const rough = withTakeOutcome(BASE, '4k', { droppedFrames: 40, expectedFrames: 100 });
    expect(rough.lastTakeSmooth).toBe(false);
    const unmeasured = withTakeOutcome(rough, '4k', null);
    expect(unmeasured.lastTakeSmooth).toBeUndefined();
    expect(unmeasured.lastDroppedFrames).toBeUndefined();
    // The quality the take used is still remembered.
    expect(unmeasured.lastQuality).toBe('4k');
  });
});

describe('provenSmoothnessSuggestion — derivation (R36 WS-4)', () => {
  it('a smooth take yields no suggestion', () => {
    const profiles = upsertDeviceProfile({}, withTakeOutcome(BASE, '4k', { droppedFrames: 0, expectedFrames: 900 }));
    expect(provenSmoothnessSuggestion(profiles, 'environment')).toBeNull();
  });

  it('a heavy-drop take yields exactly one step down, with the brief copy and a naming button', () => {
    const profiles = upsertDeviceProfile({}, withTakeOutcome(BASE, '4k', { droppedFrames: 50, expectedFrames: 900 }));
    const suggestion = provenSmoothnessSuggestion(profiles, 'environment');
    expect(suggestion).not.toBeNull();
    expect(suggestion?.fromQuality).toBe('4k');
    expect(suggestion?.suggestedQuality).toBe('hd');
    expect(suggestion?.text).toBe(SMOOTHNESS_SUGGESTION_TEXT);
    expect(suggestion?.text).toBe('The last take dropped frames at this quality — the one below may record smoother.');
    expect(suggestion?.applyLabel).toBe('Use HD');
  });

  it('auto steps down to hd the same way (both open the ladder at the top)', () => {
    const profiles = upsertDeviceProfile(
      {},
      withTakeOutcome({ ...BASE, facing: 'user' }, 'auto', { droppedFrames: 50, expectedFrames: 900 }),
    );
    expect(provenSmoothnessSuggestion(profiles, 'user')?.suggestedQuality).toBe('hd');
    // The other facing has no profile at all — no suggestion.
    expect(provenSmoothnessSuggestion(profiles, 'environment')).toBeNull();
  });

  it('already at the lowest step yields no suggestion, however rough the take', () => {
    const profiles = upsertDeviceProfile({}, withTakeOutcome(BASE, 'hd', { droppedFrames: 90, expectedFrames: 900 }));
    expect(provenSmoothnessSuggestion(profiles, 'environment')).toBeNull();
    expect(qualityStepDown('hd')).toBeNull();
    expect(qualityStepDown('4k')).toBe('hd');
    expect(qualityStepDown('auto')).toBe('hd');
  });

  it('an unmeasured last take yields no suggestion', () => {
    const profiles = upsertDeviceProfile({}, withTakeOutcome(BASE, '4k', null));
    expect(provenSmoothnessSuggestion(profiles, 'environment')).toBeNull();
  });

  it('the most recent profile for the facing governs (a later smooth take clears the suggestion)', () => {
    let profiles = upsertDeviceProfile({}, withTakeOutcome(BASE, '4k', { droppedFrames: 50, expectedFrames: 900 }));
    expect(provenSmoothnessSuggestion(profiles, 'environment')).not.toBeNull();
    profiles = upsertDeviceProfile(
      profiles,
      withTakeOutcome({ ...BASE, shortSideClass: '1080' }, 'hd', { droppedFrames: 1, expectedFrames: 900 }),
    );
    expect(provenSmoothnessSuggestion(profiles, 'environment')).toBeNull();
  });
});

describe('persistence shape — compatible extension (R36 WS-4)', () => {
  it('a pre-R36 stored profile (core fields only) still parses, unchanged', () => {
    const legacy = JSON.stringify({ 'environment:2160': BASE });
    expect(parseDeviceProfiles(legacy)).toEqual({ 'environment:2160': BASE });
  });

  it('a profile carrying smoothness fields round-trips through storage', () => {
    const withOutcome = withTakeOutcome(BASE, '4k', { droppedFrames: 50, expectedFrames: 900 });
    const map = upsertDeviceProfile({}, withOutcome);
    expect(parseDeviceProfiles(serializeDeviceProfiles(map))).toEqual(map);
  });

  it('malformed optional fields are dropped without costing the core profile', () => {
    const json = JSON.stringify({
      'environment:2160': { ...BASE, lastTakeSmooth: 'yes', lastQuality: '8k', lastDroppedFrames: -2 },
    });
    const parsed = parseDeviceProfiles(json);
    expect(parsed['environment:2160']).toEqual(BASE);
  });
});

describe('captureReceiptSmoothnessVerdict (R36 WS-4)', () => {
  const baseInput = {
    trackSettings: { width: 1920, height: 1080, frameRate: 30 },
    mimeType: 'video/mp4',
    blobSize: 1_000_000,
    durationSeconds: 10,
  };

  it('a measured take under threshold states "Smooth take" plainly in the details line', () => {
    const receipt = buildCaptureReceipt({ ...baseInput, droppedFramesEstimate: 2, expectedFramesEstimate: 300 });
    expect(captureReceiptSmoothnessVerdict(receipt)).toBe('Smooth take');
    expect(formatCaptureReceipt(receipt).details).toBe('10 seconds · 1.0 MB · Smooth take');
    expect(captureReceiptDropWarning(receipt)).toBeNull();
  });

  it('a measured take over threshold keeps the existing advisory and gets no smooth verdict', () => {
    const receipt = buildCaptureReceipt({ ...baseInput, droppedFramesEstimate: 40, expectedFramesEstimate: 300 });
    expect(captureReceiptSmoothnessVerdict(receipt)).toBeNull();
    expect(captureReceiptDropWarning(receipt)).toBe('This take dropped frames — a retake may look smoother');
    expect(formatCaptureReceipt(receipt).details).toBe('10 seconds · 1.0 MB');
  });

  it('no estimate means no verdict — never fabricated', () => {
    const receipt = buildCaptureReceipt({ ...baseInput });
    expect(captureReceiptSmoothnessVerdict(receipt)).toBeNull();
    expect(formatCaptureReceipt(receipt).details).toBe('10 seconds · 1.0 MB');
  });
});
