import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';

// Support overriding via client-side environment variables in production builds
// (same pattern as riddimroom-caption's src/lib/firebase.ts)
const metaEnv = (import.meta as any).env || {};
const config = {
  apiKey: metaEnv.VITE_FIREBASE_API_KEY || firebaseConfig.apiKey,
  authDomain: metaEnv.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfig.authDomain,
  projectId: metaEnv.VITE_FIREBASE_PROJECT_ID || firebaseConfig.projectId,
  storageBucket: metaEnv.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfig.storageBucket,
  messagingSenderId: metaEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfig.messagingSenderId,
  appId: metaEnv.VITE_FIREBASE_APP_ID || firebaseConfig.appId,
  measurementId: metaEnv.VITE_FIREBASE_MEASUREMENT_ID || firebaseConfig.measurementId,
};

const app = getApps().length === 0 ? initializeApp(config) : getApp();
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const db = getFirestore(app);
const storage = getStorage(app);

// Local emulator support (Plan v5 Phase 3L): ONLY active when the build
// sets VITE_FIREBASE_EMULATOR=true (e.g. a local proof build against a
// demo project). Unset — every normal build — this block never runs and
// behavior is exactly as before.
if (metaEnv.VITE_FIREBASE_EMULATOR === 'true') {
  connectAuthEmulator(auth, metaEnv.VITE_FIREBASE_AUTH_EMULATOR_URL || 'http://127.0.0.1:9099', {
    disableWarnings: true,
  });
  connectFirestoreEmulator(
    db,
    metaEnv.VITE_FIREBASE_FIRESTORE_EMULATOR_HOST || '127.0.0.1',
    Number(metaEnv.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT || 8080),
  );
}

export { app, auth, googleProvider, db, storage };
