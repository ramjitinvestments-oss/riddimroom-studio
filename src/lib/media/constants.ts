/**
 * RiddimRoom Studio — universal 30-second media standard.
 *
 * Single shared source of truth for the product's hard duration limits, per
 * the explicit "do not scatter hardcoded 30 values throughout the code"
 * requirement. Every place that needs to know the media/project length cap
 * or the fade-duration cap imports from here — camera auto-stop, upload
 * over-length detection, the pre-import trim/select modal, the project-level
 * duration guard (`ProjectContext.mutate`), item duration clamping
 * (`trimItemEnd`/`setItemDuration` in `lib/timeline/utils.ts`), and the fade
 * math in `lib/render/compositor.ts`.
 */

/** Hard ceiling, in seconds, for any single media item (camera recording, uploaded video/audio, video/audio/image timeline item) AND for a whole assembled project. */
export const MAX_MEDIA_SECONDS = 30;

/** Hard ceiling, in seconds, for an audio/video fade-in or fade-out. The *effective* max is always `min(MAX_FADE_SECONDS, clip duration)` — see `computeFadeOpacity` in `lib/render/compositor.ts`. */
export const MAX_FADE_SECONDS = 3;

/** Small tolerance for floating-point drift when comparing a computed duration against a hard limit (mirrors the `0.05`/`0.1` epsilons already used throughout `lib/timeline/utils.ts`). */
export const DURATION_LIMIT_EPSILON_SECONDS = 0.05;
