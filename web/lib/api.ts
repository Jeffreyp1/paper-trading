// Shared server-side helpers for talking to upstream backends.
// Not exposed to the browser.

export const NODE_API = process.env.NODE_API ?? "http://localhost:3000";
export const GO_API = process.env.GO_API ?? "http://localhost:8081";

const DEFAULT_TIMEOUT_MS = 1500;

export async function tryFetch(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      cache: "no-store",
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function tryJson<T = unknown>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T | null> {
  const res = await tryFetch(url, init);
  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
