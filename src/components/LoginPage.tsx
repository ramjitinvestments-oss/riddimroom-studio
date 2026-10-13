import React, { useState } from 'react';
import { Mail, Lock, User, ArrowRight, KeyRound, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import BrandLogo from './BrandLogo';

/**
 * Source: riddimroom-caption's src/components/LoginPage.tsx (mode-switching
 * login/signup/forgot-password UX, validation rules, and copy).
 *
 * Deviation: reads/calls the shared AuthContext directly via useAuth()
 * instead of taking ~9 callback/state props from a parent App.tsx, since
 * this component now needs to be mountable from either entry point.
 * Validation rules (password length, required fields) are unchanged.
 */
export function LoginPage() {
  const { signInWithGoogle, signInWithEmail, signUpWithEmail, resetPassword, authError, clearAuthError } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [forgotSuccess, setForgotSuccess] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const error = localError || authError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAuthError();
    setLocalError(null);
    setForgotSuccess(null);

    if (mode === 'login') {
      if (!email || !password) {
        setLocalError('Please fill in all email and password fields.');
        return;
      }
    } else if (mode === 'signup') {
      if (!email || !password || !displayName) {
        setLocalError('Please fill in your name, email, and password.');
        return;
      }
      if (password.length < 6) {
        setLocalError('Password must be at least 6 characters.');
        return;
      }
    } else if (mode === 'forgot') {
      if (!email) {
        setLocalError('Please enter your email address.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      if (mode === 'login') {
        await signInWithEmail(email, password, rememberMe);
      } else if (mode === 'signup') {
        await signUpWithEmail(email, password, displayName, rememberMe);
      } else {
        await resetPassword(email);
        setForgotSuccess('Password reset email sent. Check your inbox.');
      }
    } catch {
      // error already surfaced via authError/localError
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogle = async () => {
    clearAuthError();
    setLocalError(null);
    setIsSubmitting(true);
    try {
      await signInWithGoogle(rememberMe);
    } catch {
      // surfaced via authError
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#070707] text-white px-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <BrandLogo size="lg" />
          <p className="text-xs text-white/40 uppercase tracking-widest">
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password'}
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {forgotSuccess && (
          <div className="flex items-start gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-xs text-emerald-300">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{forgotSuccess}</span>
          </div>
        )}

        <button
          onClick={handleGoogle}
          disabled={isSubmitting}
          className="w-full py-3 bg-white text-black font-bold text-sm rounded-xl flex items-center justify-center gap-2 disabled:opacity-40"
        >
          Continue with Google
        </button>

        <div className="flex items-center gap-3 text-[10px] text-white/30 uppercase tracking-widest">
          <div className="flex-1 h-px bg-white/10" />
          or
          <div className="flex-1 h-px bg-white/10" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'signup' && (
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3">
              <User className="w-4 h-4 text-white/30" />
              <input
                type="text"
                placeholder="Display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="flex-1 bg-transparent py-3 text-sm outline-none placeholder-white/30"
              />
            </div>
          )}
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3">
            <Mail className="w-4 h-4 text-white/30" />
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 bg-transparent py-3 text-sm outline-none placeholder-white/30"
            />
          </div>
          {mode !== 'forgot' && (
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3">
              <Lock className="w-4 h-4 text-white/30" />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex-1 bg-transparent py-3 text-sm outline-none placeholder-white/30"
              />
            </div>
          )}

          {mode === 'login' && (
            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center gap-2 text-white/50">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="accent-emerald-500"
                />
                Remember me
              </label>
              <button type="button" onClick={() => setMode('forgot')} className="text-emerald-400 hover:underline">
                Forgot password?
              </button>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3 bg-emerald-500 text-black font-bold text-sm rounded-xl flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset email'}
            {mode === 'forgot' ? <KeyRound className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
          </button>
        </form>

        <p className="text-center text-xs text-white/40">
          {mode === 'login' && (
            <>
              No account?{' '}
              <button onClick={() => setMode('signup')} className="text-emerald-400 hover:underline">
                Create one
              </button>
            </>
          )}
          {mode === 'signup' && (
            <>
              Already have an account?{' '}
              <button onClick={() => setMode('login')} className="text-emerald-400 hover:underline">
                Sign in
              </button>
            </>
          )}
          {mode === 'forgot' && (
            <button onClick={() => setMode('login')} className="text-emerald-400 hover:underline">
              Back to sign in
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
