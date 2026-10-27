import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import BrandLogo from './BrandLogo';

/**
 * Phase 2 (Plan v5) — the owner's Admin screen: every signup by email,
 * newest first, with two access switches per row (R28): "Allow access"
 * (pending <-> basic) and "Premium" (basic <-> premium). Switching calls
 * POST /api/admin/set-access with { uid, access } and the owner's Firebase
 * ID token (the same Authorization-header pattern every /api call in this
 * app uses); the server re-verifies admin status and writes the license +
 * status + approvals log. The "Export emails" button builds the marketing
 * list (CSV) from the loaded rows, client-side — no extra endpoint.
 *
 * Only rendered when userProfile.isAdmin (App.tsx gates the route); the
 * server is the real gate regardless.
 */

interface AdminUserRow {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  createdAt: string | null;
  status: string;
  plan: string;
  subscription: string;
  marketingOptIn: boolean;
  licenseTier: 'free' | 'lifetime';
  accessState: 'pending' | 'basic' | 'premium';
}

interface AdminPanelProps {
  onBack: () => void;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function AdminPanel({ onBack }: AdminPanelProps) {
  const { idToken } = useAuth();
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!idToken) return;
    setError(null);
    try {
      const res = await fetch('/api/admin/users', {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Failed to load users (${res.status}).`);
      }
      setUsers(data.users as AdminUserRow[]);
    } catch (err: any) {
      setError(err?.message || 'Failed to load users.');
    }
  }, [idToken]);

  useEffect(() => {
    load();
  }, [load]);

  const pendingCount = useMemo(
    () => (users ? users.filter((u) => u.status === 'pending').length : 0),
    [users],
  );

  const visible = useMemo(() => {
    if (!users) return null;
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q),
    );
  }, [users, query]);

  const setAccess = useCallback(
    async (uid: string, access: AdminUserRow['accessState']) => {
      if (!idToken || busyUid) return;
      setBusyUid(uid);
      setError(null);
      try {
        const res = await fetch('/api/admin/set-access', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${idToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ uid, access }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || `Failed to update access (${res.status}).`);
        }
        const updated = data.user as AdminUserRow;
        setUsers((prev) =>
          prev ? prev.map((u) => (u.uid === updated.uid ? { ...u, ...updated } : u)) : prev,
        );
      } catch (err: any) {
        setError(err?.message || 'Failed to update access.');
      } finally {
        setBusyUid(null);
      }
    },
    [idToken, busyUid],
  );

  const handleExportEmails = useCallback(() => {
    if (!users) return;
    const header = 'email,name,signup date,status,access,marketing opt-in';
    const lines = users.map((u) =>
      [
        csvCell(u.email),
        csvCell(u.displayName),
        csvCell(u.createdAt ? new Date(u.createdAt).toISOString() : ''),
        csvCell(u.status),
        csvCell(u.accessState),
        csvCell(u.marketingOptIn ? 'yes' : 'no'),
      ].join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'riddimroom-signups.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [users]);

  return (
    <div className="min-h-screen bg-[#070707] text-white">
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/10">
        <BrandLogo size="sm" />
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold uppercase"
        >
          <ArrowLeft size={14} /> Studio
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h1 className="text-lg font-black uppercase">Signups</h1>
          {users && (
            <span
              className={`px-3 py-1.5 rounded-full border text-xs font-bold ${
                pendingCount > 0
                  ? 'bg-gold/15 border-gold/60 text-gold'
                  : 'bg-white/5 border-white/10 text-white/50'
              }`}
            >
              {pendingCount} pending
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={handleExportEmails}
            disabled={!users || users.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 min-h-[36px] text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black"
          >
            <Download size={14} /> Export emails (CSV)
          </button>
        </div>
        <p className="text-xs text-white/40 mb-6">
          Allow access switches a signup on with the free plan (short projects, a few exports a
          day, watermark on). Premium lifts the limits — unlimited exports, no watermark, longer
          projects. Switching access off returns them to the pending screen — their projects are
          kept. The export is the marketing list for the Riddim List.
        </p>

        <div className="relative mb-4">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by email or name"
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2.5 text-sm placeholder:text-white/30 focus:outline-none focus:border-gold/60"
          />
        </div>

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

        {visible === null && !error && (
          <div className="space-y-3" aria-label="Loading signups">
            {[0, 1, 2].map((i) => (
              <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4 animate-pulse">
                <div className="h-4 w-1/2 rounded bg-white/10" />
                <div className="h-3 w-1/3 rounded bg-white/5 mt-2" />
              </div>
            ))}
          </div>
        )}

        {visible !== null && visible.length === 0 && (
          <div className="text-center py-16 border border-dashed border-white/10 rounded-xl">
            <p className="text-sm text-white/40">
              {users && users.length > 0 ? 'No signups match that search.' : 'No signups yet.'}
            </p>
          </div>
        )}

        {visible && visible.length > 0 && (
          <ul className="space-y-3">
            {visible.map((row) => {
              const hasAccess = row.accessState !== 'pending';
              const isPremium = row.accessState === 'premium';
              const isBusy = busyUid === row.uid;
              return (
                <li
                  key={row.uid}
                  className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-3"
                >
                  {row.photoURL ? (
                    <img src={row.photoURL} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
                  ) : (
                    <span className="w-10 h-10 rounded-full bg-white/10 shrink-0 flex items-center justify-center font-black text-white/60">
                      {(row.displayName || row.email || '?').slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-bold truncate">{row.displayName || row.email}</p>
                    <p className="text-xs text-white/50 truncate">{row.email}</p>
                    <p className="text-xs text-white/40 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {row.accessState === 'pending' ? (
                        <span className="px-2 py-0.5 rounded-full border bg-gold/15 border-gold/60 text-gold text-[10px] font-bold uppercase">
                          Pending
                        </span>
                      ) : row.accessState === 'premium' ? (
                        <span className="px-2 py-0.5 rounded-full border bg-emerald-400/15 border-emerald-400/60 text-emerald-400 text-[10px] font-bold uppercase">
                          Premium
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full border bg-sky-400/15 border-sky-400/60 text-sky-300 text-[10px] font-bold uppercase">
                          Basic
                        </span>
                      )}
                      <span>
                        Signed up {row.createdAt ? new Date(row.createdAt).toLocaleDateString() : '—'}
                      </span>
                      <span>· Marketing: {row.marketingOptIn ? 'opted in' : 'no'}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-start gap-3">
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] font-bold uppercase text-white/50">Access</span>
                      <button
                        role="switch"
                        aria-checked={hasAccess}
                        aria-label={`Allow access for ${row.email}`}
                        onClick={() => setAccess(row.uid, hasAccess ? 'pending' : 'basic')}
                        disabled={isBusy}
                        className={`relative shrink-0 w-14 h-8 rounded-full border transition disabled:opacity-50 ${
                          hasAccess ? 'bg-gold border-gold' : 'bg-white/10 border-white/20'
                        }`}
                      >
                        <span
                          className={`absolute top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-white shadow transition-all ${
                            hasAccess ? 'left-[26px]' : 'left-[3px] opacity-70'
                          }`}
                        />
                        <span
                          className={`absolute inset-y-0 flex items-center text-[10px] font-black uppercase ${
                            hasAccess ? 'left-2 text-black' : 'right-2 text-white/60'
                          }`}
                        >
                          {isBusy ? '…' : hasAccess ? 'On' : 'Off'}
                        </span>
                      </button>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] font-bold uppercase text-white/50">Premium</span>
                      <button
                        role="switch"
                        aria-checked={isPremium}
                        aria-label={`Premium for ${row.email}`}
                        onClick={() => setAccess(row.uid, isPremium ? 'basic' : 'premium')}
                        disabled={isBusy}
                        className={`relative shrink-0 w-14 h-8 rounded-full border transition disabled:opacity-50 ${
                          isPremium ? 'bg-gold border-gold' : 'bg-white/10 border-white/20'
                        }`}
                      >
                        <span
                          className={`absolute top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-white shadow transition-all ${
                            isPremium ? 'left-[26px]' : 'left-[3px] opacity-70'
                          }`}
                        />
                        <span
                          className={`absolute inset-y-0 flex items-center text-[10px] font-black uppercase ${
                            isPremium ? 'left-2 text-black' : 'right-2 text-white/60'
                          }`}
                        >
                          {isBusy ? '…' : isPremium ? 'On' : 'Off'}
                        </span>
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
