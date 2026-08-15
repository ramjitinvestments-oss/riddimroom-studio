// Phase 1 Step 10/13 verification — live checks against the real dev
// server + real Auth emulator for the parts of POST /api/transcribe that
// don't require a reachable Firestore backend (auth gate, input
// validation, ownership check — all evaluated before any Firestore call
// in server.ts). The Firestore-dependent quota/provider-selection path is
// covered separately by code review + the isolated provider unit tests in
// test-transcription-providers.mts, since this sandbox has no reachable
// Firestore (see PROGRESS.md).
import http from 'node:http';

const API_KEY = 'fake-api-key';
const AUTH_EMULATOR = 'http://localhost:9099';
const APP_PORT = 8123;

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}${detail ? ' -- ' + detail : ''}`);
    failed++;
  }
}

async function identityToolkit(path, body) {
  const res = await fetch(`${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/${path}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function postTranscribe(token, body) {
  const res = await fetch(`http://localhost:${APP_PORT}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

async function main() {
  const email = `transcribetest_${Date.now()}@example.com`;
  const signUp = await identityToolkit('accounts:signUp', { email, password: 'TestPassw0rd!', returnSecureToken: true });
  const token = signUp.idToken;
  check('Test user registered against the Auth emulator', !!token, JSON.stringify(signUp));

  const noAuth = await postTranscribe(null, { storageUrl: 'https://x/o/users%2Fabc%2Fmedia%2F1?alt=media', mimeType: 'video/mp4' });
  check('No Authorization header -> 401 (never reaches quota/provider logic)', noAuth.status === 401, `status=${noAuth.status}`);

  const badToken = await postTranscribe('not-a-real-jwt', { storageUrl: 'https://x/o/users%2Fabc%2Fmedia%2F1?alt=media', mimeType: 'video/mp4' });
  check('Invalid token -> 401', badToken.status === 401, `status=${badToken.status}`);

  const missingBody = await postTranscribe(token, {});
  check('Missing storageUrl -> 400', missingBody.status === 400, `status=${missingBody.status} body=${JSON.stringify(missingBody.json)}`);

  const missingMime = await postTranscribe(token, { storageUrl: 'https://x/o/users%2Fabc%2Fmedia%2F1?alt=media' });
  check('Missing mimeType -> 400', missingMime.status === 400, `status=${missingMime.status}`);

  const wrongOwner = await postTranscribe(token, {
    storageUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/users%2Fsome-other-uid%2Fmedia%2F1%2Fclip.mp4?alt=media',
    mimeType: 'video/mp4',
  });
  check(
    "storageUrl belonging to a different user's path -> 403 (ownership check runs before any Firestore/provider call)",
    wrongOwner.status === 403,
    `status=${wrongOwner.status} body=${JSON.stringify(wrongOwner.json)}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exitCode = 1;
});
