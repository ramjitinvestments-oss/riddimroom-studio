import React, { useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './components/LoginPage';
import { useRouter } from './lib/router';

function AppShell() {
  const { currentPath, navigateTo } = useRouter();
  const { currentUser, userProfile, isAuthLoading, isAccountDisabled, signOut } = useAuth();

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

  return (
    <ProtectedRoute redirectTo={navigateTo}>
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-[#070707] text-white">
        <h1 className="text-2xl font-black tracking-tight uppercase">RiddimRoom Studio</h1>
        <p className="text-sm text-white/50 max-w-md">
          Signed in as <span className="text-emerald-400">{userProfile?.email || currentUser?.email}</span>
          {' · '}role <span className="text-emerald-400">{userProfile?.role ?? '…'}</span>
          {' · '}status <span className="text-emerald-400">{userProfile?.status ?? '…'}</span>
        </p>
        <p className="text-xs text-white/30 max-w-md">
          Capture, upload, and the shared editor are added in the next build steps.
        </p>
        <button
          onClick={signOut}
          className="mt-2 px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold uppercase tracking-wider"
        >
          Sign out
        </button>
      </div>
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
