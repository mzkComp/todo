import { fail } from "../core/errors.mjs";

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8" },
});
export const redirect = (location, cookie) => new Response(null, {
  status: 303, headers: { location, ...(cookie ? { "set-cookie": cookie } : {}) },
});

export async function readBody(request) {
  if (!request.body) return {};
  const chunks = [], reader = request.body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512 * 1024) { await reader.cancel(); throw fail(413, "请求体太大"); }
    chunks.push(value);
  }
  if (!size) return {};
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  if (request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  let body;
  try { body = JSON.parse(text); } catch { throw fail(400, "不是合法的 JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "请求体必须是 JSON 对象");
  return body;
}

export function secureResponse(response, request) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, no-transform");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (new URL(request.url).protocol === "https:") headers.set("strict-transport-security", "max-age=31536000");
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}
