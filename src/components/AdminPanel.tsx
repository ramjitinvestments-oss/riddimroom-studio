import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import BrandLogo from './BrandLogo';
import { FAILURE_KIND_LABELS, type FailureCountsSummary, type FailureKind } from '../lib/failureCounts';
import type { DeletionRequestRow } from '../lib/accountDeletion';

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
  // R40 P-29: waiting-only view — one tap shows just the pending rows.
  const [waitingOnly, setWaitingOnly] = useState(false);
  // R40 P-21: an access change never fires on the switch tap itself —
  // it waits here for the confirm dialog's answer first.
  const [confirmAccess, setConfirmAccess] = useState<{
    row: AdminUserRow;
    access: AdminUserRow['accessState'];
  } | null>(null);
  // R40 P-28 — "What's failing": first-party failure counts (counts
  // only, no user content). Loads quietly alongside the signup list;
  // if it cannot load, the section simply stays hidden.
  const [failureSummary, setFailureSummary] = useState<FailureCountsSummary | null>(null);
  // R40 P-27 — account deletion requests: who asked, and when. Loads
  // quietly alongside the other readouts; hidden when it cannot load.
  const [deletionRequests, setDeletionRequests] = useState<DeletionRequestRow[] | null>(null);

  useEffect(() => {
    if (!idToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/deletion-requests', {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && data?.success) setDeletionRequests(data.requests as DeletionRequestRow[]);
      } catch {
        // The readout is a help, never a blocker on the admin screen.
      }
    })();
    return () => { cancelled = true; };
  }, [idToken]);

  useEffect(() => {
    if (!idToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/failure-counts', {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && data?.success) setFailureSummary(data.summary as FailureCountsSummary);
      } catch {
        // The readout is a help, never a blocker on the admin screen.
      }
    })();
    return () => { cancelled = true; };
  }, [idToken]);

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
    let list = users;
    if (waitingOnly) list = list.filter((u) => u.status === 'pending');
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (u) => u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q),
    );
  }, [users, query, waitingOnly]);

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

  // R40 P-21: the export is exactly the list the label promises —
  // the people currently on screen (search + waiting filter applied)
  // who said yes to marketing emails, name and email only.
  const handleExportEmails = useCallback(() => {
    if (!visible) return;
    const optedIn = visible.filter((u) => u.marketingOptIn);
    const header = 'name,email';
    const lines = optedIn.map((u) => [csvCell(u.displayName), csvCell(u.email)].join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'riddimroom-marketing-emails.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [visible]);

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
            disabled={!visible || visible.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 min-h-11 text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black"
          >
            <Download size={14} /> Export emails (CSV)
          </button>
        </div>
        <p className="text-xs text-white/60 mb-4">
          Allow access switches a signup on with the free plan (projects up to 30 seconds, 3 exports a
          day, watermark on). Premium lifts the limits — projects up to 10 minutes, unlimited exports, no watermark. Switching access off returns them to the pending screen — their projects are
          kept. Every switch asks you to confirm first. The export gives you name and email for exactly the people on screen who said yes to marketing emails — no one else is in the file.
        </p>
        {failureSummary && (
          <section className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-4" aria-label="What's failing">
            <h2 className="text-xs font-black uppercase tracking-wide text-white/70">What&rsquo;s failing</h2>
            <p className="text-xs text-white/50 mt-1">Counts only — how many jobs failed, nothing about anyone&rsquo;s projects.</p>
            <div className="grid grid-cols-3 gap-2 mt-3 text-center">
              {(Object.keys(FAILURE_KIND_LABELS) as FailureKind[]).map((kind) => (
                <div key={kind} className="rounded-lg bg-black/30 border border-white/10 px-2 py-3">
                  <p className="text-lg font-black">{failureSummary.today[kind]}</p>
                  <p className="text-[11px] text-white/50">{FAILURE_KIND_LABELS[kind]} today</p>
                  <p className="text-[11px] text-white/40">{failureSummary.last7Days[kind]} in the last 7 days</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {deletionRequests && deletionRequests.length > 0 && (
          <section className="mb-6 rounded-xl border border-white/10 bg-white/[0.03] p-4" aria-label="Account deletion requests">
            <h2 className="text-xs font-black uppercase tracking-wide text-white/70">Account deletion requests</h2>
            <p className="text-xs text-white/50 mt-1">
              To complete a request: switch the account off here (the access switches below), then delete
              the user in the Firebase console. The app does not delete the account itself — recording the
              request is all it does.
            </p>
            <ul className="mt-3 flex flex-col gap-1">
              {deletionRequests.map((row) => (
                <li key={row.uid} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-xs">
                  <span className="font-bold text-white/80">{row.email || row.uid}</span>
                  <span className="text-white/40">
                    {row.requestedAt ? `Asked ${new Date(row.requestedAt).toLocaleString()}` : 'Asking date not recorded'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex flex-wrap items-center gap-2 mb-6">
          <button
            onClick={() => setWaitingOnly((v) => !v)}
            aria-pressed={waitingOnly}
            className={`px-4 py-2 min-h-11 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide rounded-lg border transition ${
              waitingOnly
                ? 'bg-gold/15 border-gold/60 text-gold'
                : 'bg-white/5 hover:bg-white/10 border-white/10 text-white/70'
            }`}
          >
            Waiting for access
          </button>
          {waitingOnly && (
            <span className="text-xs text-white/60">Showing only the people still waiting for access.</span>
          )}
        </div>

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
            <p className="text-xs text-white/40">Loading signups…</p>
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
              {users && users.length > 0
                ? waitingOnly
                  ? 'Nobody is waiting for access in this view.'
                  : 'No signups match that search.'
                : 'No signups yet.'}
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
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] font-bold uppercase text-white/50">Access</span>
                      <button
                        role="switch"
                        aria-checked={hasAccess}
                        aria-label={`Allow access for ${row.email}`}
                        onClick={() => setConfirmAccess({ row, access: hasAccess ? 'pending' : 'basic' })}
                        disabled={isBusy}
                        className={`relative shrink-0 w-14 h-11 rounded-full border transition disabled:opacity-50 ${
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
                          {hasAccess ? 'On' : 'Off'}
                        </span>
                      </button>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-[10px] font-bold uppercase text-white/50">Premium</span>
                      <button
                        role="switch"
                        aria-checked={isPremium}
                        aria-label={`Premium for ${row.email}`}
                        onClick={() => setConfirmAccess({ row, access: isPremium ? 'basic' : 'premium' })}
                        disabled={isBusy}
                        className={`relative shrink-0 w-14 h-11 rounded-full border transition disabled:opacity-50 ${
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
                          {isPremium ? 'On' : 'Off'}
                        </span>
                      </button>
                    </div>
                    </div>
                    {isBusy && <span className="text-[10px] font-bold text-white/50">Saving…</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {confirmAccess && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => !busyUid && setConfirmAccess(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm access change"
            className="bg-[#111] border border-white/10 rounded-2xl p-6 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-bold text-base">
              Switch {confirmAccess.row.displayName || confirmAccess.row.email} to{' '}
              {confirmAccess.access === 'premium'
                ? 'Premium'
                : confirmAccess.access === 'basic'
                  ? 'Basic'
                  : 'Waiting for access'}
              ?
            </h2>
            <p className="text-sm text-white/60 mt-2">
              {confirmAccess.access === 'pending'
                ? 'They go back to the waiting screen. Their projects are kept.'
                : confirmAccess.access === 'premium'
                  ? 'Projects up to 10 minutes, unlimited exports, no watermark.'
                  : 'The free plan: projects up to 30 seconds, 3 exports a day, watermark on.'}
            </p>
            <div className="flex gap-2 mt-6">
              <button
                onClick={() => setConfirmAccess(null)}
                disabled={!!busyUid}
                className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 disabled:opacity-50 border border-white/10 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const pendingChange = confirmAccess;
                  setConfirmAccess(null);
                  void setAccess(pendingChange.row.uid, pendingChange.access);
                }}
                disabled={!!busyUid}
                className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black"
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
