import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useProject } from '../../context/ProjectContext';
import { canExportToday, exportsRemainingToday, type LicenseTier } from '../../lib/licensing';
import { resolveAdminFallbackTier } from '../../hooks/useLicenseTier';

interface LicenseInfo { tier: LicenseTier; watermarkEnabled: boolean; checkoutAvailable: boolean; }

function useLicense(): LicenseInfo & { loading: boolean; refresh: () => void } {
  const { currentUser: user, idToken } = useAuth();
  const [info, setInfo] = useState<LicenseInfo>({ tier: 'free', watermarkEnabled: true, checkoutAvailable: false });
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    // No-server fallback: resolve the effective tier from the caller's
    // own admins/{uid} doc (admin = lifetime, everyone else free) so the
    // owner isn't shown Free gates on builds where /api/* doesn't exist.
    const applyFallback = async () => {
      const t = await resolveAdminFallbackTier(user.uid);
      setInfo({ tier: t, watermarkEnabled: t !== 'lifetime', checkoutAvailable: false });
    };
    try {
      const res = await fetch('/api/license', { headers: idToken ? { Authorization: `Bearer ${idToken}` } : {} });
      // On builds without the API (e.g. the static preview) the lookup
      // 404s — that's expected there, not a user-facing error. Quietly
      // keep the Free defaults instead of alarming the user with a
      // "License lookup failed (404)" banner.
      if (!res.ok) { await applyFallback(); return; }
      const data = await res.json();
      setInfo({ tier: data.tier ?? 'free', watermarkEnabled: data.watermarkEnabled ?? true, checkoutAvailable: !!data.checkoutAvailable });
    } catch { await applyFallback(); }
    finally { setLoading(false); }
  }, [user, idToken]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { ...info, loading, refresh };
}

/** v1 Licensing — free vs one-time lifetime. Upgrade button calls /api/checkout. */
export function LicensingPanel() {
  const { currentUser: user, idToken } = useAuth();
  const { project, mutate } = useProject();
  const { tier, loading, checkoutAvailable } = useLicense();
  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const remaining = user ? exportsRemainingToday(user.uid, tier) : null;
  const canExport = user ? canExportToday(user.uid, tier) : false;
  const isPaid = tier === 'lifetime';

  const handleCheckout = async () => {
    setBusy(true); setCheckoutError(null); setCheckoutUrl(null);
    try {
      const res = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) }, body: JSON.stringify({}) });
      // R34 (R33 audit §2): genuine unavailability is rendered BEFORE the
      // button (see checkoutAvailable below), never as a post-click
      // failure — and never with the old "preview" sentence, which fired
      // for ANY failure including on production. A click that fails here
      // is a start failure: one plain retry line, no raw messages.
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      if (!res.ok || !isJson) {
        setCheckoutError("Checkout couldn't start — check your connection and try again.");
        return;
      }
      const data = await res.json();
      if (data.checkoutUrl) setCheckoutUrl(data.checkoutUrl);
      else setCheckoutError("Checkout couldn't start — check your connection and try again.");
    } catch { setCheckoutError("Checkout couldn't start — check your connection and try again."); }
    finally { setBusy(false); }
  };

  const handleToggleWatermark = (enabled: boolean) => {
    if (!isPaid && !enabled) return; // free users cannot disable watermark
    if (project) mutate((p) => ({ ...p, watermarkEnabled: enabled }));
  };

  return (
    <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl p-4">
      <h3 className="text-sm font-bold">Your plan</h3>
      {loading ? <p className="text-xs text-white/40">Checking plan…</p> : (
        <p className="text-xs text-white/70">Current plan: <span className="font-bold text-white">{isPaid ? 'Lifetime' : 'Free'}</span></p>
      )}
      <ul className="text-xs text-white/60 space-y-1">
        <li>• Free: projects up to 30 seconds · {remaining === null ? '—' : `${remaining} export${remaining === 1 ? '' : 's'} left today`} · 2 transcriptions/day · watermark on</li>
        <li>• Lifetime — $35 one-time: projects up to 10 minutes · 10 transcriptions/day · unlimited exports · no watermark · all templates</li>
      </ul>
      {!isPaid && (
        <>
          {/* R34: when checkout genuinely isn't available on this build,
              say so BEFORE the button and disable it — not as a failure
              after the click. */}
          <button onClick={handleCheckout} disabled={busy || loading || !checkoutAvailable} className="px-4 py-3 rounded-lg bg-white text-black font-bold text-sm min-h-11 disabled:opacity-50">
            {busy ? 'Starting checkout…' : 'Upgrade to Lifetime — $35 one-time'}
          </button>
          {!loading && !checkoutAvailable && <p className="text-xs text-white/50">Checkout isn't available here yet.</p>}
          {checkoutError && <p className="text-xs text-amber-400">{checkoutError}</p>}
          {checkoutUrl && <p className="text-xs text-white/70"><a className="underline" href={checkoutUrl} target="_blank" rel="noreferrer">Continue to checkout</a></p>}
        </>
      )}
      {isPaid && <p className="text-xs text-emerald-400">Lifetime unlocked — no watermark, full templates, projects up to 10 minutes.</p>}
      <label className="flex items-center gap-2 text-xs text-white/70">
        <input type="checkbox" checked={project?.watermarkEnabled !== false} onChange={(e) => handleToggleWatermark(e.target.checked)} disabled={!isPaid} />
        Show “RiddimRoom Studio” watermark on exports {isPaid ? '' : '(Lifetime only — free exports always show it)'}
      </label>
      {!canExport && user && <p className="text-xs text-amber-400">Daily free export limit reached. Upgrade to Lifetime for more.</p>}
    </div>
  );
}
