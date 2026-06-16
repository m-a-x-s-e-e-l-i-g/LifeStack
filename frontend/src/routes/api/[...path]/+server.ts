import type { RequestHandler } from "./$types";
import { BACKEND_URL } from "$lib/server/backend";

/** Transparent proxy so the browser only ever talks to the frontend origin. */
const handler: RequestHandler = async ({ params, request, url }) => {
  const target = `${BACKEND_URL}/api/${params.path}${url.search}`;
  const method = request.method;
  const headers: Record<string, string> = {};
  const contentType = request.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = await request.text();

  const res = await fetch(target, init);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
