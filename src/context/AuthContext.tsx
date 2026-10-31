import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { User as FirebaseUser, Auth } from 'firebase/auth';
import type { GoogleAuthProvider } from 'firebase/auth';
import { loadFirebase, scheduleFirebaseLoad } from '../lib/firebaseLoader';
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
 *
 * R40 P-10: Firebase itself is no longer statically imported here —
 * it loads lazily through lib/firebaseLoader, so the login route can
 * paint without the Firebase chunk. Loading starts (a) immediately
 * when any sign-in control is used, and (b) on an idle callback
 * shortly after first paint, so a returning user's session restores
 * without a tap. Until the load lands, the provider simply stays in
 * its loading state — the same state ProtectedRoute already covers
 * with its spinner. Once loaded, every behavior below is exactly as
 * before: the pending gate, the account-disabled/restricted handling,
 * sign-out and session persistence are untouched.
 */

type FirebaseAuthModule = typeof import('firebase/auth');

interface LoadedFirebase {
  auth: Auth;
  googleProvider: GoogleAuthProvider;
  fns: FirebaseAuthModule;
}

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
  const loadedRef = useRef<LoadedFirebase | null>(null);
  const loadPromiseRef = useRef<Promise<LoadedFirebase> | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Ported from riddimroom-caption's fetchUserQuota — calls the backend
  // (token-verified) rather than reading Firestore directly from the
  // client, so the server remains the single source of truth for
  // role/status/quota. This also triggers the backend's upsert-on-first-
  // login logic (user doc creation, lastLogin update).
  const fetchUserProfile = useCallback(async (token: string, loaded: LoadedFirebase) => {
    try {
      const res = await fetch('/api/user/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setIsAccountDisabled(true);
          await loaded.fns.signOut(loaded.auth);
        }
        return;
      }
      const data = await res.json();
      if (data.success && data.user) {
        if (data.user.status === 'suspended' || data.user.status === 'denied') {
          setIsAccountDisabled(true);
          await loaded.fns.signOut(loaded.auth);
          return;
        }
        setIsAccountDisabled(false);
        setUserProfile(data.user);
      }
    } catch (e) {
      console.error('[AuthContext] fetchUserProfile failed:', e);
    }
  }, []);

  // Start (or join) the one Firebase load and, when it lands, attach
  // the auth-state listener exactly once. Before it lands the provider
  // stays in the loading state — there is no session to report yet.
  const ensureFirebase = useCallback((): Promise<LoadedFirebase> => {
    if (loadedRef.current) return Promise.resolve(loadedRef.current);
    if (!loadPromiseRef.current) {
      loadPromiseRef.current = (async () => {
        const [fb, fns] = await Promise.all([loadFirebase(), import('firebase/auth')]);
        const loaded: LoadedFirebase = { auth: fb.auth, googleProvider: fb.googleProvider, fns };
        loadedRef.current = loaded;
        unsubscribeRef.current = fns.onAuthStateChanged(loaded.auth, async (user) => {
          setIsAuthLoading(true);
          setCurrentUser(user);
          if (user) {
            setIsAccountDisabled(false);
            try {
              const token = await user.getIdToken(true);
              setIdToken(token);
              await fetchUserProfile(token, loaded);
            } catch (e) {
              console.error('[AuthContext] Error refreshing token on auth state change:', e);
            }
          } else {
            setIdToken(null);
            setUserProfile(null);
          }
          setIsAuthLoading(false);
        });
        return loaded;
      })().catch((err) => {
        // A failed load must not wedge sign-in: forget the attempt so
        // the next tap (or the next idle tick) tries again, and leave
        // the loading state so the login screen stays usable.
        loadPromiseRef.current = null;
        setIsAuthLoading(false);
        throw err;
      });
    }
    return loadPromiseRef.current;
  }, [fetchUserProfile]);

  // Idle preload: shortly after first paint, start the load so a
  // returning user's session restores on its own. Interaction paths
  // call ensureFirebase directly and never wait for this.
  useEffect(() => {
    scheduleFirebaseLoad(() => {
      void ensureFirebase().catch(() => undefined);
    });
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [ensureFirebase]);

  const signInWithGoogle = useCallback(async (rememberMe: boolean) => {
    setAuthError(null);
    try {
      const loaded = await ensureFirebase();
      await loaded.fns.setPersistence(loaded.auth, rememberMe ? loaded.fns.browserLocalPersistence : loaded.fns.browserSessionPersistence);
      const result = await loaded.fns.signInWithPopup(loaded.auth, loaded.googleProvider);
      if (result.user) {
        const token = await result.user.getIdToken(true);
        setIdToken(token);
        await fetchUserProfile(token, loaded);
      }
    } catch (e: any) {
      console.error('[AuthContext] Google sign-in failed:', e);
      setAuthError(`Google sign-in failed: ${e.message}`);
      throw e;
    }
  }, [ensureFirebase, fetchUserProfile]);

  const signUpWithEmail = useCallback(async (email: string, password: string, displayName: string, rememberMe: boolean) => {
    setAuthError(null);
    try {
      const loaded = await ensureFirebase();
      await loaded.fns.setPersistence(loaded.auth, rememberMe ? loaded.fns.browserLocalPersistence : loaded.fns.browserSessionPersistence);
      const result = await loaded.fns.createUserWithEmailAndPassword(loaded.auth, email.trim(), password);
      if (result.user) {
        if (displayName.trim()) {
          await loaded.fns.updateProfile(result.user, { displayName: displayName.trim() });
        }
        const token = await result.user.getIdToken(true);
        setIdToken(token);
        await fetchUserProfile(token, loaded);
      }
    } catch (e: any) {
      const msg = friendlyAuthError(e);
      console.error('[AuthContext] Email sign-up failed:', e);
      setAuthError(msg);
      throw new Error(msg);
    }
  }, [ensureFirebase, fetchUserProfile]);

  const signInWithEmail = useCallback(async (email: string, password: string, rememberMe: boolean) => {
    setAuthError(null);
    try {
      const loaded = await ensureFirebase();
      await loaded.fns.setPersistence(loaded.auth, rememberMe ? loaded.fns.browserLocalPersistence : loaded.fns.browserSessionPersistence);
      const result = await loaded.fns.signInWithEmailAndPassword(loaded.auth, email.trim(), password);
      if (result.user) {
        const token = await result.user.getIdToken(true);
        setIdToken(token);
        await fetchUserProfile(token, loaded);
      }
    } catch (e: any) {
      const msg = friendlyAuthError(e);
      console.error('[AuthContext] Email sign-in failed:', e);
      setAuthError(msg);
      throw new Error(msg);
    }
  }, [ensureFirebase, fetchUserProfile]);

  const resetPassword = useCallback(async (email: string) => {
    setAuthError(null);
    try {
      const loaded = await ensureFirebase();
      await loaded.fns.sendPasswordResetEmail(loaded.auth, email.trim());
    } catch (e: any) {
      const msg = friendlyAuthError(e);
      console.error('[AuthContext] Password reset failed:', e);
      setAuthError(msg);
      throw new Error(msg);
    }
  }, [ensureFirebase]);

  const signOut = useCallback(async () => {
    // If Firebase has not loaded yet there is no live session to end —
    // clearing the local state is the whole job. (The restricted
    // screen's sign-out reloads to /login regardless.)
    if (loadedRef.current) {
      await loadedRef.current.fns.signOut(loadedRef.current.auth);
    }
    setCurrentUser(null);
    setIdToken(null);
    setUserProfile(null);
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const refreshUserProfile = useCallback(async () => {
    if (!currentUser) return;
    const loaded = loadedRef.current ?? (await ensureFirebase());
    const token = await currentUser.getIdToken(true);
    setIdToken(token);
    await fetchUserProfile(token, loaded);
  }, [currentUser, ensureFirebase, fetchUserProfile]);

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
