import React, { useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './components/LoginPage';
import { Dashboard } from './components/Dashboard';
import { PendingScreen } from './components/PendingScreen';
import { AdminPanel } from './components/AdminPanel';
import { PromoPage } from './components/PromoPage';
import { EditorShell } from './components/Editor/EditorShell';
import { useRouter } from './lib/router';

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
  const { currentUser, userProfile, isAuthLoading, isAccountDisabled } = useAuth();

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

  if (isAccountDisabled) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center bg-[#070707] text-white">
        <h1 className="text-lg font-black uppercase">Account access restricted</h1>
        <p className="text-sm text-white/50 max-w-sm">
          Your account is currently pending, suspended, or denied. Contact an administrator for access.
        </p>
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
          <AdminPanel onBack={() => navigateTo('/')} />
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
        <PromoPage
          onOpenProject={(projectId) => navigateTo(`/editor/${encodeURIComponent(projectId)}`)}
          onBack={() => navigateTo('/')}
        />
      </ProtectedRoute>
    );
  }

  const editorMatch = currentPath.match(/^\/editor\/([^/]+)$/);

  return (
    <ProtectedRoute redirectTo={navigateTo}>
      {editorMatch ? (
        <EditorShell projectId={decodeURIComponent(editorMatch[1])} />
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
