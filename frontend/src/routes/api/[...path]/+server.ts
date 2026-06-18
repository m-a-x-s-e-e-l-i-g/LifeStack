import type { RequestHandler } from "./$types";
import { BACKEND_URL } from "$lib/server/backend";

/** Transparent proxy so the browser only ever talks to the frontend origin. */
const handler: RequestHandler = async ({ params, request, url }) => {
  try {
    const target = `${BACKEND_URL}/api/${params.path}${url.search}`;
    const method = request.method;
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);

    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      const raw = await request.arrayBuffer();
      if (raw.byteLength > 0) init.body = raw;
    }

    const res = await fetch(target, init);
    const outHeaders = new Headers(res.headers);
    if (!outHeaders.has("content-type")) outHeaders.set("content-type", "application/json");
    return new Response(res.body, {
      status: res.status,
      headers: outHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `Proxy request failed: ${message}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
