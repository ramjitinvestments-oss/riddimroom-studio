import React, { Suspense, lazy, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './components/LoginPage';
import { LegalPage } from './components/LegalPage';
import { SupportLink } from './components/SupportLink';
import BrandLogo from './components/BrandLogo';
import { useRouter } from './lib/router';

// R27 WS-M7 — route-level code splitting: Promo, Editor and Admin load
// on navigation instead of up front. LoginPage and ProtectedRoute stay
// eager (first paint / gate surfaces).
// R40 P-10 — Dashboard and PendingScreen are lazy too: both reach the
// Firebase chunk statically (project persistence / a direct Firestore
// write), and Firebase must not be part of the login route's first
// download. The gate logic is unchanged — these components only ever
// render for a signed-in user whose profile has already loaded, which
// means Firebase has loaded by then; the Suspense fallback below is
// the same loading screen the other lazy routes use.
const PromoPage = lazy(() => import('./components/PromoPage').then((m) => ({ default: m.PromoPage })));
const EditorShell = lazy(() => import('./components/Editor/EditorShell').then((m) => ({ default: m.EditorShell })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then((m) => ({ default: m.AdminPanel })));
const Dashboard = lazy(() => import('./components/Dashboard').then((m) => ({ default: m.Dashboard })));
const PendingScreen = lazy(() => import('./components/PendingScreen').then((m) => ({ default: m.PendingScreen })));

function RouteLoading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-[#070707] text-white">
      <BrandLogo size="lg" />
      {/* R40 P-48: words AND a spinner — every loading state says what
          is loading and shows motion while it does. */}
      <div className="w-10 h-10 rounded-full border-4 border-gold/20 border-t-gold animate-spin" aria-hidden="true" />
      <p className="text-sm text-white/50">Loading…</p>
    </div>
  );
}

/**
 * Phase 1 Step 14 (UI refinement). Replaces the Step 2 placeholder
 * ("Capture, upload, and the shared editor are added in the next build
 * steps") with the real product: `Dashboard` (project list/create) at `/`,
 * `EditorShell` at `/editor/:projectId`. `useRouter` only tracks the raw
 * path string (by design — see its own header comment); route param
 * parsing happens here rather than growing the router into a full routing
 * library for two routes.
 */
function AppShell() {
  const { currentPath, navigateTo } = useRouter();
  const { currentUser, userProfile, isAuthLoading, isAccountDisabled, accessBlockReason, signOut } = useAuth();

  // UX-02 / R40 P-23: leaving the restricted screen below. AuthContext
  // retains the access-block reason across sign-out (the gate itself
  // already signed the user out when it set the reason), so this
  // screen can name the true state; the explicit Sign out here loads
  // the login page fresh, which is what returns the user to a working
  // screen.
  const handleRestrictedSignOut = async () => {
    try {
      await signOut();
    } catch {
      // Best effort only — the fresh load below still returns to sign-in.
    } finally {
      window.location.assign('/login');
    }
  };

  // Redirect unauthenticated users to /login; redirect authenticated users
  // away from /login — same behavior as riddimroom-caption's two
  // corresponding useEffects in App.tsx.
  useEffect(() => {
    if (!isAuthLoading && !currentUser && currentPath !== '/login' && currentPath !== '/privacy' && currentPath !== '/terms') {
      navigateTo('/login');
    }
  }, [isAuthLoading, currentUser, currentPath, navigateTo]);

  useEffect(() => {
    if (!isAuthLoading && currentUser && currentPath === '/login') {
      navigateTo('/');
    }
  }, [isAuthLoading, currentUser, currentPath, navigateTo]);

  // R40 P-04: Privacy and Terms are public pages — reachable without
  // sign-in, from the login footer and the dashboard footer alike.
  if (currentPath === '/privacy' || currentPath === '/terms') {
    return (
      <LegalPage
        kind={currentPath === '/privacy' ? 'privacy' : 'terms'}
        onBack={() => navigateTo(currentUser ? '/' : '/login')}
      />
    );
  }

  // UX-02: when the profile is available and says the account is only
  // pending, the user belongs on the pending screen — never on the
  // restricted screen below, whose wording is for other states.
  if (currentUser && userProfile && userProfile.status === 'pending' && !userProfile.isAdmin) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <PendingScreen onOpenLegal={(path) => navigateTo(path)} />
      </Suspense>
    );
  }

  if (isAccountDisabled) {
    // R40 P-23: the copy names the TRUE state, from the reason
    // AuthContext retained across the sign-out. 'switched-off' needs
    // the owner (email us); 'unreachable' means no account state was
    // ever read, so trying again is the honest first step.
    const unreachable = accessBlockReason === 'unreachable';
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center bg-[#070707] text-white">
        <h1 className="text-lg font-black uppercase">Account access restricted</h1>
        <p className="text-sm text-white/50 max-w-sm">
          {unreachable
            ? 'We couldn’t reach the server — check your connection and try again. Nothing is known to be wrong with your account.'
            : 'Your account is switched off — email us if you think that’s wrong, or sign out and sign in with a different account.'}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-3 min-h-11 inline-flex items-center justify-center bg-gold hover:bg-gold-bright text-black text-xs font-bold uppercase tracking-wide rounded-lg"
          >
            Try again
          </button>
          <button
            onClick={handleRestrictedSignOut}
            className="px-4 py-3 min-h-11 inline-flex items-center justify-center bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold uppercase tracking-wide rounded-lg"
          >
            Sign out
          </button>
        </div>
        <SupportLink />
      </div>
    );
  }

  if (currentPath === '/login') {
    return <LoginPage onOpenLegal={(path) => navigateTo(path)} />;
  }

  // Phase 2 (Plan v5) toggle gate: a signed-in user whose profile is
  // still 'pending' gets the waiting screen instead of the product, on
  // every route. Admins are exempt — the owner is never gated by status
  // (and his own profile may predate the status field entirely).
  if (currentUser && userProfile && userProfile.status === 'pending' && !userProfile.isAdmin) {
    return (
      <Suspense fallback={<RouteLoading />}>
        <PendingScreen onOpenLegal={(path) => navigateTo(path)} />
      </Suspense>
    );
  }

  if (currentPath === '/admin') {
    return (
      <ProtectedRoute redirectTo={navigateTo}>
        {userProfile?.isAdmin ? (
          <Suspense fallback={<RouteLoading />}>
            <AdminPanel onBack={() => navigateTo('/')} />
          </Suspense>
        ) : (
          <Suspense fallback={<RouteLoading />}>
            <Dashboard
              onOpenProject={(projectId) => navigateTo(`/editor/${encodeURIComponent(projectId)}`)}
              onOpenAdmin={() => navigateTo('/admin')}
              onOpenPromo={() => navigateTo('/promo')}
              onOpenLegal={(path) => navigateTo(path)}
            />
          </Suspense>
        )}
      </ProtectedRoute>
    );
  }

  // Viral Promo mode. The pending-account gate above already applies to
  // every route, so only owner-approved (toggled-on) users reach this.
  if (currentPath === '/promo') {
    return (
      <ProtectedRoute redirectTo={navigateTo}>
        <Suspense fallback={<RouteLoading />}>
          <PromoPage
            onOpenProject={(projectId) => navigateTo(`/editor/${encodeURIComponent(projectId)}`)}
            onBack={() => navigateTo('/')}
          />
        </Suspense>
      </ProtectedRoute>
    );
  }

  const editorMatch = currentPath.match(/^\/editor\/([^/]+)$/);

  return (
    <ProtectedRoute redirectTo={navigateTo}>
      {editorMatch ? (
        <Suspense fallback={<RouteLoading />}>
          <EditorShell projectId={decodeURIComponent(editorMatch[1])} />
        </Suspense>
      ) : (
        <Suspense fallback={<RouteLoading />}>
          <Dashboard
            onOpenProject={(projectId) => navigateTo(`/editor/${encodeURIComponent(projectId)}`)}
            onOpenAdmin={() => navigateTo('/admin')}
            onOpenPromo={() => navigateTo('/promo')}
            onOpenLegal={(path) => navigateTo(path)}
          />
        </Suspense>
      )}
    </ProtectedRoute>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
