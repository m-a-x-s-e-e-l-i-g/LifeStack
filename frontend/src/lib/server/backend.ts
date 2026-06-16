import { env } from "$env/dynamic/private";

/** Internal URL the SvelteKit server uses to reach the backend (docker network). */
export const BACKEND_URL = env.BACKEND_URL || "http://localhost:4000";

/** Fetch JSON from the backend, server side. Throws on non-2xx. */
export async function backendJson<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`);
  if (!res.ok) throw new Error(`backend responded ${res.status} for ${path}`);
  return (await res.json()) as T;
}
