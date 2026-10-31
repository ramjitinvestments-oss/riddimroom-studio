import React from 'react';
import { useAuth } from '../context/AuthContext';

/**
 * Source: riddimroom-caption's src/components/ProtectedRoute.tsx.
 *
 * Deviation: caption's version takes currentUser/isAuthLoading/userQuota as
 * props threaded down from its monolithic App.tsx. This version reads the
 * same state from the shared AuthContext instead, since the unified app has
 * two entry points that both need the same gating logic. The loading state,
 * redirect-on-unauthenticated behavior, and role-gating logic are otherwise
 * unchanged from the source.
 */

interface ProtectedRouteProps {
  requiredRole?: 'admin';
  redirectTo: (path: string) => void;
  children: React.ReactNode;
}

export function ProtectedRoute({ requiredRole, redirectTo, children }: ProtectedRouteProps) {
  const { currentUser, userProfile, isAuthLoading } = useAuth();

  if (isAuthLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#070707] text-white">
        <div className="w-12 h-12 rounded-full border-4 border-gold/20 border-t-gold animate-spin"></div>
        <p className="mt-4 text-xs font-semibold text-white/50 tracking-wider uppercase animate-pulse">
          Loading RiddimRoom Studio…
        </p>
      </div>
    );
  }

  if (!currentUser) {
    setTimeout(() => {
      redirectTo('/login');
    }, 0);
    return null;
  }

  if (requiredRole && userProfile?.role !== requiredRole) {
    setTimeout(() => {
      redirectTo('/');
    }, 0);
    return null;
  }

  return <>{children}</>;
}
