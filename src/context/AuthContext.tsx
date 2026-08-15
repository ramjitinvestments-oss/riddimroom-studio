import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  type User as FirebaseUser,
} from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import type { ClientUserProfile } from '../types/user';

/**
 * Shared authentication context/provider.
 *
 * Source: behavior ported from riddimroom-caption's inline auth state
 * (src/App.tsx, onAuthStateChanged/handleGoogleLogin/handleEmailAuthDirect/
 * handleForgotPasswordDirect) and its src/components/ProtectedRoute.tsx.
 *
 * Deviation from source: caption manages this state inline inside its
 * single App.tsx component. That doesn't work for the unified app, which
 * needs the same auth state available to two separate entry points
 * (capture and import) plus the shared editor and, later, the admin panel.
 * This was extracted into a standalone context per your explicit Phase 1
 * Step 2 requirement ("Shared authentication context/provider"). The
 * underlying Firebase calls and error-handling behavior are unchanged.
 */

interface AuthContextValue {
  currentUser: FirebaseUser | null;
  userProfile: ClientUserProfile | null;
  idToken: string | null;
  isAuthLoading: boolean;
  authError: string | null;
  isAccountDisabled: boolean;
  signInWithGoogle: (rememberMe: boolean) => Promise<void>;
  signUpWithEmail: (email: string, password: string, displayName: string, rememberMe: boolean) => Promise<void>;
  signInWithEmail: (email: string, password: string, rememberMe: boolean) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearAuthError: () => void;
  refreshUserProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Friendly error-message mapping ported verbatim from
// riddimroom-caption's handleEmailAuthDirect catch block.
function friendlyAuthError(err: any): string {
  const code = err?.code;
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Invalid email or password. Please try again.';
  }
  if (code === 'auth/email-already-in-use') {
    return 'This email is already in use. Try signing in instead.';
  }
  if (code === 'auth/weak-password') {
    return 'Password should be at least 6 characters.';
  }
  if (code === 'auth/invalid-email') {
    return 'Please enter a valid email address.';
  }
  return err?.message || 'Something went wrong. Please try again.';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<ClientUserProfile | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAccountDisabled, setIsAccountDisabled] = useState(false);

  // Ported from riddimroom-caption's fetchUserQuota — calls the backend
  // (token-verified) rather than reading Firestore directly from the
  // client, so the server remains the single source of truth for
  // role/status/quota. This also triggers the backend's upsert-on-first-
  // login logic (user doc creation, lastLogin update).
  const fetchUserProfile = useCallback(async (token: string) => {
    try {
      const res = await fetch('/api/user/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setIsAccountDisabled(true);
          await firebaseSignOut(auth);
        }
        return;
      }
      const data = await res.json();
      if (data.success && data.user) {
        if (data.user.status === 'suspended' || data.user.status === 'denied') {
          setIsAccountDisabled(true);
          await firebaseSignOut(auth);
          return;
        }
        setIsAccountDisabled(false);
        setUserProfile(data.user);
      }
    } catch (e) {
      console.error('[AuthContext] fetchUserProfile failed:', e);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setIsAuthLoading(true);
      setCurrentUser(user);
      if (user) {
        setIsAccountDisabled(false);
        try {
          const token = await user.getIdToken(true);
          setIdToken(token);
          await fetchUserProfile(token);
        } catch (e) {
          console.error('[AuthContext] Error refreshing token on auth state change:', e);
        }
      } else {
        setIdToken(null);
        setUserProfile(null);
      }
      setIsAuthLoading(false);
    });
    return () => unsubscribe();
  }, [fetchUserProfile]);

  const signInWithGoogle = useCallback(async (rememberMe: boolean) => {
    setAuthError(null);
    try {
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user) {
        const token = await result.user.getIdToken(true);
        setIdToken(token);
        await fetchUserProfile(token);
      }
    } catch (e: any) {
      console.error('[AuthContext] Google sign-in failed:', e);
      setAuthError(`Google sign-in failed: ${e.message}`);
      throw e;
    }
  }, [fetchUserProfile]);

  const signUpWithEmail = useCallback(async (email: string, password: string, displayName: string, rememberMe: boolean) => {
    setAuthError(null);
    try {
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
      const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (result.user) {
        if (displayName.trim()) {
          await updateProfile(result.user, { displayName: displayName.trim() });
        }
        const token = await result.user.getIdToken(true);
        setIdToken(token);
        await fetchUserProfile(token);
      }
    } catch (e: any) {
      const msg = friendlyAuthError(e);
      console.error('[AuthContext] Email sign-up failed:', e);
      setAuthError(msg);
      throw new Error(msg);
    }
  }, [fetchUserProfile]);

  const signInWithEmail = useCallback(async (email: string, password: string, rememberMe: boolean) => {
    setAuthError(null);
    try {
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
      const result = await signInWithEmailAndPassword(auth, email.trim(), password);
      if (result.user) {
        const token = await result.user.getIdToken(true);
        setIdToken(token);
        await fetchUserProfile(token);
      }
    } catch (e: any) {
      const msg = friendlyAuthError(e);
      console.error('[AuthContext] Email sign-in failed:', e);
      setAuthError(msg);
      throw new Error(msg);
    }
  }, [fetchUserProfile]);

  const resetPassword = useCallback(async (email: string) => {
    setAuthError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (e: any) {
      const msg = friendlyAuthError(e);
      console.error('[AuthContext] Password reset failed:', e);
      setAuthError(msg);
      throw new Error(msg);
    }
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
    setCurrentUser(null);
    setIdToken(null);
    setUserProfile(null);
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const refreshUserProfile = useCallback(async () => {
    if (!currentUser) return;
    const token = await currentUser.getIdToken(true);
    setIdToken(token);
    await fetchUserProfile(token);
  }, [currentUser, fetchUserProfile]);

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        userProfile,
        idToken,
        isAuthLoading,
        authError,
        isAccountDisabled,
        signInWithGoogle,
        signUpWithEmail,
        signInWithEmail,
        resetPassword,
        signOut,
        clearAuthError,
        refreshUserProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
