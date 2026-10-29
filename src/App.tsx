import React, { Suspense, lazy, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './components/Dashboard';
import { PendingScreen } from './components/PendingScreen';
import BrandLogo from './components/BrandLogo';
import { useRouter } from './lib/router';

// R27 WS-M7 — route-level code splitting: Promo, Editor and Admin load
// on navigation instead of up front. Dashboard, LoginPage, PendingScreen
// and ProtectedRoute stay eager (first paint / gate surfaces).
const PromoPage = lazy(() => import('./components/PromoPage').then((m) => ({ default: m.PromoPage })));
const EditorShell = lazy(() => import('./components/Editor/EditorShell').then((m) => ({ default: m.EditorShell })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then((m) => ({ default: m.AdminPanel })));

function RouteLoading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-[#070707] text-white">
      <BrandLogo size="lg" />
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
  const { currentUser, userProfile, isAuthLoading, isAccountDisabled, signOut } = useAuth();

  // UX-02: leaving the restricted screen below. AuthContext's signOut does
  // not clear isAccountDisabled, and the gate itself already signed the
  // user out when it set that flag — so after signing out, load the login
  // page fresh; that is what actually returns the user to a working screen.
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
    if (!isAuthLoading && !currentUser && currentPath !== '/login') {
      navigateTo('/login');
    }
  }, [isAuthLoading, currentUser, currentPath, navigateTo]);

  useEffect(() => {
    if (!isAuthLoading && currentUser && currentPath === '/login') {
      navigateTo('/');
    }
  }, [isAuthLoading, currentUser, currentPath, navigateTo]);

  // UX-02: when the profile is available and says the account is only
  // pending, the user belongs on the pending screen — never on the
  // restricted screen below, whose wording is for other states.
  if (currentUser && userProfile && userProfile.status === 'pending' && !userProfile.isAdmin) {
    return <PendingScreen />;
  }

  if (isAccountDisabled) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center bg-[#070707] text-white">
        <h1 className="text-lg font-black uppercase">Account access restricted</h1>
        <p className="text-sm text-white/50 max-w-sm">
          This account can&rsquo;t use RiddimRoom Studio right now. Try again to re-check your
          access, or sign out and sign in with a different account.
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
      </div>
    );
  }

  if (currentPath === '/login') {
    return <LoginPage />;
  }

  // Phase 2 (Plan v5) toggle gate: a signed-in user whose profile is
  // still 'pending' gets the waiting screen instead of the product, on
  // every route. Admins are exempt — the owner is never gated by status
  // (and his own profile may predate the status field entirely).
  if (currentUser && userProfile && userProfile.status === 'pending' && !userProfile.isAdmin) {
    return <PendingScreen />;
  }

  if (currentPath === '/admin') {
    return (
      <ProtectedRoute redirectTo={navigateTo}>
        {userProfile?.isAdmin ? (
          <Suspense fallback={<RouteLoading />}>
            <AdminPanel onBack={() => navigateTo('/')} />
          </Suspense>
        ) : (
          <Dashboard
            onOpenProject={(projectId) => navigateTo(`/editor/${encodeURIComponent(projectId)}`)}
            onOpenAdmin={() => navigateTo('/admin')}
            onOpenPromo={() => navigateTo('/promo')}
          />
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
        <Dashboard
          onOpenProject={(projectId) => navigateTo(`/editor/${encodeURIComponent(projectId)}`)}
          onOpenAdmin={() => navigateTo('/admin')}
          onOpenPromo={() => navigateTo('/promo')}
        />
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
