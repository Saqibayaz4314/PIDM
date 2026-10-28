import { setTimeout as sleep } from 'node:timers/promises';

const transient = new Set([408, 429, 500, 502, 503, 504]);

export class TransferError extends Error {
  constructor(message, { retryable = false, retryAfter = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

export function retryAfter(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// A lease covers the response body, not just receipt of the HTTP headers.
export class TransferPool {
  constructor({ connections = 12, perHost = 8, retries = 3, backoffMs = 250, stallMs = 30000, maxRetryWaitMs = 120000 } = {}) {
    Object.assign(this, { connections, perHost, retries, backoffMs, stallMs, maxRetryWaitMs });
    this.active = 0;
    this.hosts = new Map();
    this.waiting = [];
    this.cooldowns = new Map();
  }

  acquire(host, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { host, signal, resolve, reject };
      entry.abort = () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(signal.reason);
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }

  drain() {
    for (let index = 0; index < this.waiting.length && this.active < this.connections;) {
      const entry = this.waiting[index];
      if ((this.hosts.get(entry.host) || 0) >= this.perHost) { index++; continue; }
      this.waiting.splice(index, 1);
      entry.signal.removeEventListener('abort', entry.abort);
      this.active++;
      this.hosts.set(entry.host, (this.hosts.get(entry.host) || 0) + 1);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        const remaining = this.hosts.get(entry.host) - 1;
        if (remaining) this.hosts.set(entry.host, remaining); else this.hosts.delete(entry.host);
        this.drain();
      });
    }
  }

  async retry(url, signal, operation, onRetry = () => {}) {
    const host = new URL(url).hostname;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      while ((this.cooldowns.get(host) || 0) > Date.now()) {
        const cooldown = this.cooldowns.get(host) - Date.now();
        if (cooldown > this.maxRetryWaitMs) throw new Error('Server requested a long wait. Retry this download later.');
        await sleep(cooldown, undefined, { signal });
      }
      this.cooldowns.delete(host);
      try { return await operation(); }
      catch (error) {
        signal.throwIfAborted();
        const retryable = error instanceof TransferError ? error.retryable : error instanceof TypeError && /fetch|terminated|network/i.test(error.message);
        if (!retryable || attempt >= this.retries) throw error;
        if (error.retryAfter > this.maxRetryWaitMs) throw new Error(`Server requested a wait of ${Math.ceil(error.retryAfter / 1000)} seconds. Retry later.`);
        const delay = Math.max(error.retryAfter || 0, Math.min(8000, this.backoffMs * 2 ** attempt));
        this.cooldowns.set(host, Math.max(this.cooldowns.get(host) || 0, Date.now() + delay));
        onRetry({ attempt: attempt + 1, delay });
      }
    }
  }

  async response(url, { signal, headers }, consume) {
    const host = new URL(url).hostname;
    let release;
    for (;;) {
      release = await this.acquire(host, signal);
      const cooldown = (this.cooldowns.get(host) || 0) - Date.now();
      if (cooldown <= 0) break;
      release();
      if (cooldown > this.maxRetryWaitMs) throw new Error('Server requested a long wait. Retry this download later.');
      await sleep(cooldown, undefined, { signal });
    }
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    let timer;
    let response;
    let lastActivity = Date.now();
    const pulse = () => { lastActivity = Date.now(); };
    const checkStall = () => {
      const remaining = this.stallMs - (Date.now() - lastActivity);
      if (remaining <= 0) { timeout.abort(new TransferError('Download stalled; the server stopped sending data', { retryable: true })); return; }
      timer = setTimeout(checkStall, remaining);
      timer.unref?.();
    };
    try {
      checkStall();
      response = await fetch(url, { headers, signal: combined, redirect: 'follow' });
      if (!response.ok) {
        const delay = retryAfter(response.headers.get('retry-after'));
        if ([429, 503].includes(response.status) && delay) this.cooldowns.set(host, Math.max(this.cooldowns.get(host) || 0, Date.now() + delay));
        throw new TransferError(`HTTP ${response.status}`, { retryable: transient.has(response.status), retryAfter: delay });
      }
      return await consume(response, pulse, combined);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.signal.aborted) throw timeout.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      if (response) await response.body?.cancel().catch(() => {});
      release();
    }
  }
}
