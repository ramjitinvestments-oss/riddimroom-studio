import React from 'react';
import { ArrowLeft } from 'lucide-react';
import BrandLogo from './BrandLogo';
import { SupportLink } from './SupportLink';
import {
  PRIVACY_INTRO,
  PRIVACY_SECTIONS,
  PRIVACY_TITLE,
  TERMS_INTRO,
  TERMS_SECTIONS,
  TERMS_TITLE,
} from '../lib/legalCopy';

/**
 * R40 P-04 — the Privacy and Terms pages. Reachable WITHOUT sign-in
 * (App routes /privacy and /terms before the sign-in redirect), from
 * the login footer and the dashboard footer. The words come from
 * lib/legalCopy so there is exactly one text.
 */
export function LegalPage({ kind, onBack }: { kind: 'privacy' | 'terms'; onBack: () => void }) {
  const title = kind === 'privacy' ? PRIVACY_TITLE : TERMS_TITLE;
  const intro = kind === 'privacy' ? PRIVACY_INTRO : TERMS_INTRO;
  const sections = kind === 'privacy' ? PRIVACY_SECTIONS : TERMS_SECTIONS;
  return (
    <div className="min-h-screen bg-[#070707] text-white">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <BrandLogo size="sm" />
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 min-h-11 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold uppercase"
        >
          <ArrowLeft size={14} /> Back
        </button>
      </header>
      <main className="max-w-2xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-black">{title}</h1>
        <p className="mt-3 text-sm text-white/70 leading-relaxed">{intro}</p>
        {sections.map((section) => (
          <section key={section.heading} className="mt-7">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gold">{section.heading}</h2>
            {section.paragraphs.map((paragraph, i) => (
              <p key={i} className="mt-2 text-sm text-white/70 leading-relaxed">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
        <div className="mt-10 border-t border-white/10 pt-4">
          <SupportLink />
        </div>
      </main>
    </div>
  );
}
