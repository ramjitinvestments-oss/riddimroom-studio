import React from 'react';

/**
 * R40 P-03 — the ONE support route for end users. Every surface that
 * offers help (login, pending, dashboard, plan panel) renders this
 * component, so the address and the wording can never drift apart.
 */
export const SUPPORT_EMAIL = 'riddimroom.com@gmail.com';

export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

export function SupportLink({ className }: { className?: string }) {
  return (
    <a
      href={SUPPORT_MAILTO}
      className={
        className ??
        'inline-flex items-center justify-center min-h-11 text-xs font-bold text-gold hover:underline'
      }
    >
      Questions? Email us
    </a>
  );
}
