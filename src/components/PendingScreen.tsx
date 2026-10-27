import React, { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import BrandLogo from './BrandLogo';

/**
 * Phase 2 (Plan v5) — the waiting room for a signed-in user whose account
 * status is 'pending'. Signups are switched on by the owner from the
 * Admin screen (the toggle); until then the dashboard/editor are replaced
 * by this screen. It also carries the marketing opt-in: the one profile
 * field a user may write themselves (a direct update to their own
 * users/{uid} doc — firestore.rules freezes only the privileged fields,
 * so this stays a safe client write).
 */
export function PendingScreen() {
  const { currentUser, userProfile, signOut, refreshUserProfile } = useAuth();
  const email = userProfile?.email || currentUser?.email || '';
  const [optIn, setOptIn] = useState<boolean>(userProfile?.marketingOptIn === true);
  const [optInSaved, setOptInSaved] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleOptInChange = async (checked: boolean) => {
    setOptIn(checked);
    setOptInSaved(false);
    if (!currentUser) return;
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { marketingOptIn: checked });
      setOptInSaved(true);
    } catch (err) {
      // The preference is a nice-to-have, never a blocker on this screen.
      console.warn('[PendingScreen] marketing opt-in save failed:', err);
    }
  };

  const handleCheckAgain = async () => {
    setChecking(true);
    try {
      await refreshUserProfile();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070707] text-white flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <BrandLogo size="sm" />
        <button
          onClick={signOut}
          className="px-3 py-1.5 min-h-11 inline-flex items-center justify-center bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold uppercase"
        >
          Sign out
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl p-6 sm:p-8 text-center">
          <span className="inline-block px-3 py-1.5 rounded-full bg-gold/15 border border-gold/60 text-gold text-[11px] font-bold uppercase tracking-wide">
            Signed up · Pending
          </span>
          <h1 className="mt-5 text-xl font-black uppercase leading-snug">
            You&rsquo;re signed up — access isn&rsquo;t switched on yet
          </h1>
          <p className="mt-3 text-sm text-white/60 leading-relaxed">
            RiddimRoom Studio access is switched on by the owner for each account. You&rsquo;re on
            the list — once the owner switches your account on, this screen lifts automatically
            and is replaced by your studio, with captions, exports and no watermark. There&rsquo;s
            nothing else you need to do: you don&rsquo;t need to sign up again, and there&rsquo;s
            no need to contact anyone — unless it&rsquo;s been a while and you&rsquo;re still
            waiting here.
          </p>
          {email && (
            <p className="mt-4 text-sm">
              <span className="text-white/40">Signed up as </span>
              <span className="font-bold text-white">{email}</span>
            </p>
          )}

          <label className="mt-6 flex items-start gap-3 text-left bg-black/30 border border-white/10 rounded-xl px-4 py-3 cursor-pointer">
            <input
              type="checkbox"
              checked={optIn}
              onChange={(e) => handleOptInChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#ffd100]"
            />
            <span className="text-sm text-white/80 leading-snug">
              Email me RiddimRoom news, drops and offers
              {optInSaved && <span className="block text-xs text-emerald-400 mt-1">Saved — thank you.</span>}
            </span>
          </label>

          <button
            onClick={handleCheckAgain}
            disabled={checking}
            className="mt-6 w-full px-4 py-3 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black"
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <p className="mt-3 text-xs text-white/40">
            Already switched on? Tap Check again — access takes effect on your next load.
          </p>
        </div>
      </main>
    </div>
  );
}
