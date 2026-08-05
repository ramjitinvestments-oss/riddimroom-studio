import React, { useEffect, useState } from 'react';
import { app } from './lib/firebase';

/**
 * RiddimRoom Studio — root shell.
 *
 * This is Phase 1, Step 1 (Project foundation): confirms the app boots and
 * connects to the riddimroom-studio Firebase project. Auth, capture, upload,
 * and the shared editor are added in the subsequent build steps and are
 * intentionally not present here yet.
 */
export default function App() {
  const [firebaseReady, setFirebaseReady] = useState(false);

  useEffect(() => {
    setFirebaseReady(!!app.options.projectId);
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-black tracking-tight uppercase">RiddimRoom Studio</h1>
      <p className="text-sm text-white/50 max-w-md">
        Project foundation online. Firebase project:{' '}
        <span className="text-emerald-400">
          {firebaseReady ? app.options.projectId : 'connecting…'}
        </span>
      </p>
    </div>
  );
}
