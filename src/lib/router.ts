import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal client-side path router, ported from riddimroom-caption's
 * inline currentPath/navigateTo state (App.tsx) into a reusable hook
 * since the unified app now has more than one screen using it
 * (login, protected home, and later the editor/admin panel).
 */
export function useRouter() {
  const [currentPath, setCurrentPath] = useState<string>(() => window.location.pathname || '/');

  const navigateTo = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setCurrentPath(path);
  }, []);

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname || '/');
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return { currentPath, navigateTo };
}
