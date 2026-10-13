import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useProject } from '../../context/ProjectContext';
import { canExportToday, exportsRemainingToday, type LicenseTier } from '../../lib/licensing';

interface LicenseInfo { tier: LicenseTier; watermarkEnabled: boolean; checkoutAvailable: boolean; }

function useLicense(): LicenseInfo & { loading: boolean; error: string | null; refresh: () => void } {
  const { currentUser: user, idToken } = useAuth();
  const [info, setInfo] = useState<LicenseInfo>({ tier: 'free', watermarkEnabled: true, checkoutAvailable: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/license', { headers: idToken ? { Authorization: `Bearer ${idToken}` } : {} });
      if (!res.ok) throw new Error(`License lookup failed (${res.status})`);
      const data = await res.json();
      setInfo({ tier: data.tier ?? 'free', watermarkEnabled: data.watermarkEnabled ?? true, checkoutAvailable: !!data.checkoutAvailable });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'License lookup failed.'); }
    finally { setLoading(false); }
  }, [user, idToken]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { ...info, loading, error, refresh };
}

/** v1 Licensing — free vs one-time lifetime. Upgrade button calls /api/checkout (stub until Stripe keys are set). */
export function LicensingPanel() {
  const { currentUser: user, idToken } = useAuth();
  const { project, mutate } = useProject();
  const { tier, loading, error, checkoutAvailable } = useLicense();
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Checkout failed (${res.status})`);
      if (data.checkoutUrl) setCheckoutUrl(data.checkoutUrl);
      else setCheckoutError('Checkout is not configured yet. Add STRIPE_* keys on the server to enable it.');
    } catch (e: unknown) { setCheckoutError(e instanceof Error ? e.message : 'Checkout failed.'); }
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
      {error && <p className="text-xs text-amber-400">{error} — showing Free defaults.</p>}
      <ul className="text-xs text-white/60 space-y-1">
        <li>• Free: 30s projects · {remaining === null ? '—' : `${remaining} export${remaining === 1 ? '' : 's'} left today`} · 2 transcriptions/day · watermark on</li>
        <li>• Lifetime — $35 one-time: up to 10 min projects · 10 transcriptions/day · no watermark · all templates</li>
      </ul>
      {!isPaid && (
        <>
          <button onClick={handleCheckout} disabled={busy} className="px-4 py-3 rounded-lg bg-white text-black font-bold text-sm min-h-11 disabled:opacity-50">
            {busy ? 'Starting checkout…' : checkoutAvailable ? 'Upgrade to Lifetime — $35 one-time' : 'Upgrade to Lifetime — $35 one-time (setup needed)'}
          </button>
          {checkoutError && <p className="text-xs text-amber-400">{checkoutError}</p>}
          {checkoutUrl && <p className="text-xs text-white/70">Checkout link: <a className="underline break-all" href={checkoutUrl} target="_blank" rel="noreferrer">{checkoutUrl}</a></p>}
          <p className="text-[11px] text-white/30">Stripe Checkout is a stub until STRIPE_SECRET_KEY + STRIPE_PRICE_ID_LIFETIME are set on the server. No payment is taken in this build.</p>
        </>
      )}
      {isPaid && <p className="text-xs text-emerald-400">Lifetime unlocked — no watermark, full templates, longer videos.</p>}
      <label className="flex items-center gap-2 text-xs text-white/70">
        <input type="checkbox" checked={project?.watermarkEnabled !== false} onChange={(e) => handleToggleWatermark(e.target.checked)} disabled={!isPaid} />
        Show “RiddimRoom Studio” watermark on exports {isPaid ? '' : '(Lifetime only — free exports always show it)'}
      </label>
      {!canExport && user && <p className="text-xs text-amber-400">Daily free export limit reached. Upgrade to Lifetime for more.</p>}
    </div>
  );
}
