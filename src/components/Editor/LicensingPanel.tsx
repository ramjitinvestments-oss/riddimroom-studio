import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useProject } from '../../context/ProjectContext';
import { canExportToday, exportsRemainingLabel, type LicenseTier } from '../../lib/licensing';
import { resolveAdminFallbackTier } from '../../hooks/useLicenseTier';
import { SUPPORT_EMAIL, SupportLink } from '../SupportLink';

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

/**
 * v1 Licensing — free vs one-time lifetime. R40 (P-26): Lifetime is
 * switched on by the owner for now (request-access model) — the plan
 * surface says so up front and its one action is a gold email button.
 * There is no buy button and no payment step to fail.
 */
export function LicensingPanel() {
  const { currentUser: user } = useAuth();
  const { project, mutate } = useProject();
  const { tier, loading } = useLicense();

  const canExport = user ? canExportToday(user.uid, tier) : false;
  const isPaid = tier === 'lifetime';

  const handleToggleWatermark = (enabled: boolean) => {
    if (!isPaid && !enabled) return; // free users cannot disable watermark
    if (project) mutate((p) => ({ ...p, watermarkEnabled: enabled }));
  };

  return (
    <div className="flex flex-col gap-3 bg-white/5 border border-white/10 rounded-xl p-4">
      <h3 className="text-sm font-bold">Your plan</h3>
      {loading ? <p className="text-xs text-white/60">Checking plan…</p> : (
        <p className="text-xs text-white/70">Current plan: <span className="font-bold text-white">{isPaid ? 'Lifetime' : 'Free'}</span></p>
      )}
      {user && !loading && (
        <p className="text-xs text-white/70">{exportsRemainingLabel(user.uid, tier)}</p>
      )}
      <ul className="text-xs text-white/60 space-y-1">
        <li>• Free: projects up to 30 seconds · 3 exports a day · 2 transcriptions/day · watermark on</li>
        <li>• Lifetime — $35 one-time: projects up to 10 minutes · 10 transcriptions/day · unlimited exports · no watermark</li>
      </ul>
      {!isPaid && !loading && (
        <>
          <p className="text-xs text-white/60">
            Lifetime is switched on by the owner for now. Email us and the owner will switch it on for your account.
          </p>
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Lifetime for RiddimRoom Studio')}`}
            className="px-4 py-3 rounded-lg bg-gold hover:bg-gold-bright text-black font-bold text-sm min-h-11 inline-flex items-center justify-center"
          >
            Email us about Lifetime
          </a>
        </>
      )}
      {isPaid && <p className="text-xs text-emerald-400">Lifetime unlocked — no watermark, projects up to 10 minutes.</p>}
      <label className="flex items-center gap-2 text-xs text-white/70">
        <input type="checkbox" checked={project?.watermarkEnabled !== false} onChange={(e) => handleToggleWatermark(e.target.checked)} disabled={!isPaid} />
        Show the &ldquo;Made with RiddimRoom Studio&rdquo; watermark {isPaid ? '' : '(Lifetime only — free exports always show it)'}
      </label>
      {!canExport && user && <p className="text-xs text-amber-400">Daily free export limit reached. Lifetime gives you unlimited exports.</p>}
      <div className="border-t border-white/10 pt-2">
        <SupportLink />
      </div>
    </div>
  );
}
