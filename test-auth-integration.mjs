// Step 2 verification harness — exercises the REAL server middleware and Auth emulator.
import http from 'node:http';

const API_KEY = 'fake-api-key'; // emulator does not validate the API key
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
  const res = await fetch(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/${path}?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }
  );
  const json = await res.json();
  return { status: res.status, json };
}

async function callApi(path, token) {
  // 20s, not 10s: in this sandbox there is no reachable real Firestore
  // backend, so a request carrying a *valid* token still has to wait out
  // the Admin SDK's application-default-credentials resolution retries
  // (observed ~8.5s) before the route's own try/catch returns a clean 500 —
  // see PROGRESS.md. That's the route correctly failing closed, not a hang;
  // the timeout here just needs to outlast it.
  const res = await fetch(`http://localhost:${APP_PORT}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

async function main() {
  const email = `stepverify_${Date.now()}@example.com`;
  const password = 'TestPassw0rd!';

  const signUp = await identityToolkit('accounts:signUp', { email, password, returnSecureToken: true });
  check('Email registration creates user', signUp.status === 200 && !!signUp.json.idToken, JSON.stringify(signUp.json));
  const registrationToken = signUp.json.idToken;

  const signIn = await identityToolkit('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  check('Email login succeeds with correct password', signIn.status === 200 && !!signIn.json.idToken, JSON.stringify(signIn.json));
  const loginToken = signIn.json.idToken;

  const badSignIn = await identityToolkit('accounts:signInWithPassword', { email, password: 'WrongPassword1', returnSecureToken: true });
  check('Email login rejects wrong password', badSignIn.status !== 200, JSON.stringify(badSignIn.json));

  const resetReq = await identityToolkit('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email });
  check('Password reset request accepted by Auth backend', resetReq.status === 200, JSON.stringify(resetReq.json));

  const statusOk = await callApi('/api/user/status', loginToken);
  check('Valid token: /api/user/status returns non-401', statusOk.status !== 401, `status=${statusOk.status} body=${JSON.stringify(statusOk.json)}`);

  const invalid = await callApi('/api/user/status', 'this-is-not-a-real-jwt');
  check('Invalid token rejected with 401', invalid.status === 401, `status=${invalid.status}`);

  const missing = await callApi('/api/user/status', null);
  check('Missing Authorization header rejected with 401', missing.status === 401, `status=${missing.status}`);

  const fakeJwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2UifQ.eyJzdWIiOiJmYWtlIiwiZXhwIjoxfQ.ZmFrZXNpZ25hdHVyZQ';
  const tampered = await callApi('/api/user/status', fakeJwt);
  check('Tampered/expired-shaped token rejected with 401', tampered.status === 401, `status=${tampered.status}`);

  const statusFromRegToken = await callApi('/api/user/status', registrationToken);
  check('Freshly-registered token accepted (no forced re-login)', statusFromRegToken.status !== 401, `status=${statusFromRegToken.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exitCode = 1;
});
