import React, { useState } from 'react';

/**
 * RiddimRoom Studio — BrandLogo (v2, five-star surface audit fix).
 * Master logo: Soundwave bars (Option 2, picked 2026-10-13).
 * Black / cream / gold #FFD100 only. Used in Dashboard + Login header,
 * and as the brand mark for riddimroom.com.
 *
 * The locked asset (`/logo.jpg`) is a 1024×1024 black square whose
 * actual lockup — gold soundwave + "RIDDIMROOM" — occupies only a thin
 * centered band (measured: x 285–739, y 482–544). Rendering the whole
 * square at header height (v1) shrank the lockup to a ~2–5px sliver:
 * effectively invisible on every surface, with the wordmark carried by
 * a duplicate text span instead. v2 presents the SAME locked asset
 * cropped to its band via a clipped, aspect-matched window (the image
 * is scaled so the band exactly fills the window — no asset change, no
 * redraw), and the text span now only adds the "Studio" suffix the
 * lockup itself doesn't carry. If the image ever fails to load, the
 * full text wordmark returns as the fallback.
 */
const LOCKUP_ASPECT = 455 / 63; // measured lockup band, see header comment
const IMG_WIDTH_PCT = (1024 / 455) * 100; // band is 455 of the asset's 1024px width
const SHIFT_X_PCT = (285 / 1024) * 100; // band starts at x=285 of 1024
const SHIFT_Y_PCT = (482 / 1024) * 100; // band starts at y=482 of 1024

export default function BrandLogo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const [imgFailed, setImgFailed] = useState(false);
  // Height of the visible lockup itself (not the asset's square).
  const lockupH = size === 'sm' ? 16 : size === 'lg' ? 26 : 20;

  if (imgFailed) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="text-lg font-black uppercase tracking-tight">RiddimRoom Studio</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="relative inline-block overflow-hidden rounded-[3px] shrink-0"
        style={{ height: lockupH, width: Math.round(lockupH * LOCKUP_ASPECT) }}
        aria-hidden="true"
      >
        <img
          src="/logo.jpg"
          alt=""
          className="absolute left-0 top-0 max-w-none"
          style={{
            width: `${IMG_WIDTH_PCT}%`,
            transform: `translate(-${SHIFT_X_PCT}%, -${SHIFT_Y_PCT}%)`,
          }}
          onError={() => setImgFailed(true)}
        />
      </span>
      <span className="sr-only">RiddimRoom</span>
      <span className="text-lg font-black uppercase tracking-tight">Studio</span>
    </span>
  );
}
