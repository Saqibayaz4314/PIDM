const base = 'http://127.0.0.1:17341';
export function createConnection({ request = globalThis.fetch, storage = globalThis.chrome?.storage.local } = {}) {
  let connecting;
  async function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      let response;
      try {
        response = await request(`${base}/api/browser/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000) });
      } catch { throw new Error('Open PIDM on this computer, then try again.'); }
      if (!response.ok) throw new Error('Update and open PIDM, then retry the connection.');
      const result = await response.json();
      if (typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token)) throw new Error('PIDM returned an invalid connection. Restart the app and retry.');
      await storage.set({ token: result.token });
      return result.token;
    })();
    try { return await connecting; } finally { connecting = undefined; }
  }
  async function api(path, body, signal) {
    let token = (await storage.get('token')).token || await connect();
    const send = () => request(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Download-Token': token }, body: JSON.stringify(body), signal, credentials: 'omit', redirect: 'error' });
    let response;
    try { response = await send(); }
    catch (error) { if (signal?.aborted) throw error; throw new Error('Open PIDM on this computer, then try again.'); }
    if (response.status === 401) { token = await connect(); response = await send(); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  return { connect, api };
}
export const { connect, api } = createConnection();
