import React, { useState } from 'react';

/**
 * RiddimRoom Studio — BrandLogo (v3, R45 medallion pass).
 * Master mark: the owner-designed gold-ring medallion (adopted 2026-10-26,
 * Style Sheet §3), which superseded the 2026-10-13 master — that retired
 * mark and its clipped-band trick are gone from the app entirely.
 *
 * The medallion source (owner-set/avatar-1080.png) is an opaque black
 * square, so the assets shipped in public/ are circular-masked builds
 * (medallion-96.png for headers, medallion-hero.png for hero placements):
 * the circle is alpha, so no black box ever shows on any ground.
 *
 * The medallion carries no wordmark text, so the wordmark is real type:
 * "RiddimRoom" in cream/white, "Studio" in Riddim Gold (the gold token).
 * Sizes: sm/md/lg are the inline header lockup (medallion + wordmark side
 * by side); hero is the centred column (large medallion over the wordmark)
 * for Login and the centred loading/fallback screens. If the image ever
 * fails to load, the full text wordmark returns as the fallback.
 */
export default function BrandLogo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' | 'hero' }) {
  const [imgFailed, setImgFailed] = useState(false);

  const wordmark = (textCls: string) => (
    <span className={`${textCls} font-black tracking-tight whitespace-nowrap`}>
      RiddimRoom <span className="text-gold">Studio</span>
    </span>
  );

  if (size === 'hero') {
    return (
      <span className="inline-flex flex-col items-center gap-3">
        {!imgFailed && (
          <img
            src="/medallion-hero.png"
            alt=""
            width={96}
            height={96}
            className="w-24 h-24 rounded-full shrink-0"
            onError={() => setImgFailed(true)}
          />
        )}
        {wordmark('text-2xl')}
      </span>
    );
  }

  const px = size === 'sm' ? 28 : size === 'lg' ? 40 : 34;
  const textCls = size === 'sm' ? 'text-base' : size === 'lg' ? 'text-xl' : 'text-lg';

  return (
    <span className="inline-flex items-center gap-2">
      {!imgFailed && (
        <img
          src="/medallion-96.png"
          alt=""
          width={px}
          height={px}
          className="rounded-full shrink-0"
          style={{ width: px, height: px }}
          onError={() => setImgFailed(true)}
        />
      )}
      {wordmark(textCls)}
    </span>
  );
}
