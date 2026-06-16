/** Client-side helper that calls the `/api` proxy and unwraps JSON errors. */
export async function action<T = unknown>(
  path: string,
  method: "POST" | "PUT" | "DELETE" = "POST",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}
