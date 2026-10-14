import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { resolveEffectiveTier, type LicenseTier } from '../lib/licensing';

/**
 * The signed-in user's EFFECTIVE license tier for client display + soft
 * gates (export counter, watermark toggle, plan labels).
 *
 * Resolution order (see `resolveEffectiveTier` in lib/licensing):
 * 1. The server profile (`userProfile.licenseTier` from /api/user/status)
 *    whenever it loaded — the server is the source of truth and its tier
 *    already includes the admin grant (server.ts `getLicenseTier`).
 * 2. On builds where the API never answers (the static preview —
 *    /api/* 404s, so `userProfile` stays null), fall back to the
 *    caller's own `admins/{uid}` doc: readable by its owner per
 *    firestore.rules, written only from the console/backend. An admin
 *    (the studio owner) resolves to 'lifetime'; anyone else to 'free'.
 *
 * This only ever drives the client's soft gates — the same trust level
 * licensing.ts documents for the client generally. Anything the server
 * enforces (transcription quota) resolves its tier server-side and is
 * unaffected by this hook.
 */

// One admins-doc read per uid per session, shared by every consumer
// (Dashboard, ExportPanel, LicensingPanel) instead of one fetch each.
const adminChecks = new Map<string, Promise<boolean>>();

export function checkIsAdmin(uid: string): Promise<boolean> {
  let pending = adminChecks.get(uid);
  if (!pending) {
    pending = getDoc(doc(db, 'admins', uid))
      .then((snap) => snap.exists())
      .catch(() => false); // rules not deployed / offline — fail closed to free
    adminChecks.set(uid, pending);
  }
  return pending;
}

/** The no-server-answer fallback tier for `uid` (admin grant or free). */
export async function resolveAdminFallbackTier(uid: string): Promise<LicenseTier> {
  return resolveEffectiveTier(null, await checkIsAdmin(uid));
}

export function useLicenseTier(): { tier: LicenseTier; loading: boolean } {
  const { currentUser, userProfile } = useAuth();
  const [fallbackTier, setFallbackTier] = useState<LicenseTier | null>(null);
  const uid = currentUser?.uid ?? null;

  useEffect(() => {
    // Server profile present → it is the answer; no fallback needed.
    if (!uid || userProfile) return;
    let cancelled = false;
    resolveAdminFallbackTier(uid).then((t) => {
      if (!cancelled) setFallbackTier(t);
    });
    return () => {
      cancelled = true;
    };
  }, [uid, userProfile]);

  if (userProfile) return { tier: userProfile.licenseTier ?? 'free', loading: false };
  if (!uid) return { tier: 'free', loading: false };
  return { tier: fallbackTier ?? 'free', loading: fallbackTier === null };
}
