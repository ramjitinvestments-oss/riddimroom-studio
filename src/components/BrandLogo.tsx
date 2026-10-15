/**
 * RiddimRoom Studio — BrandLogo (v1).
 * Master logo: Soundwave bars (Option 2, picked 2026-10-13).
 * Black / cream / gold #FFD100 only. Used in Dashboard + Login header,
 * and as the brand mark for riddimroom.com.
 */
export default function BrandLogo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const h = size === 'sm' ? 'h-8' : size === 'lg' ? 'h-14' : 'h-10';
  return (
    <span className="inline-flex items-center gap-2">
      <img
        src="/logo.jpg"
        alt="RiddimRoom"
        className={`${h} w-auto rounded-md`}
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
      <span className="text-lg font-black uppercase tracking-tight">RiddimRoom Studio</span>
    </span>
  );
}
