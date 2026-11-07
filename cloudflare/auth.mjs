// Keep the original login form, signed cookies and Bearer/Basic API passwords.
import { createHmac } from "node:crypto";
import { createAuth, loginPage, safeNext } from "../server/auth.mjs";
import { readBody, json, redirect } from "./http.mjs";

const WINDOW = 600_000, MAX_TRIES = 10;
const authCache = new WeakMap();

export async function authenticate(request, env, store) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/api/health" && method === "GET") return null;
  // A fresh deployment is closed until a password is configured.
  if (!env.TODO_PASSWORD) return json({ error: "请先设置 TODO_PASSWORD Secret" }, 503);
  let auth = authCache.get(env);
  if (!auth) {
    auth = createAuth({ password: env.TODO_PASSWORD, secret: env.TODO_SECRET });
    authCache.set(env, auth);
  }
  const secure = url.protocol === "https:";
  if (path === "/login" && method === "GET") {
    const errors = { 1: "密码不对", 2: "尝试太多，请十分钟后再试" };
    const theme = await store.getMeta("theme");
    return new Response(loginPage({ next: url.searchParams.get("next") ?? "/", error: errors[url.searchParams.get("err")] ?? "", title: theme?.title || "ToDo" }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const req = { headers: Object.fromEntries(request.headers) };
  const open = (method === "GET" || method === "HEAD") && path.startsWith("/fonts/");
  if (open) return null;
  // Login attempts and invalid API credentials share a persistent limit across
  // Worker isolates. Valid session/API credentials do not write a counter.
  const login = path === "/api/login" && method === "POST";
  if (!login && auth.ok(req)) {
    if (path === "/logout") return redirect("/login", auth.clearCookie(secure));
    return null;
  }
  if (login || request.headers.has("authorization")) {
    const body = login ? await readBody(request) : {};
    const next = safeNext(body.next);
    const ip = request.headers.get("cf-connecting-ip") || "local";
    const hash = createHmac("sha256", env.TODO_SECRET || env.TODO_PASSWORD).update(ip).digest("hex");
    const start = Math.floor(Date.now() / WINDOW) * WINDOW;
    const db = env.DB.withSession("first-primary");
    const results = await db.batch([
      db.prepare("DELETE FROM login_attempts WHERE window_start < ?").bind(start),
      db.prepare(`INSERT INTO login_attempts (ip_hash, window_start, failures) VALUES (?, ?, 1)
        ON CONFLICT(ip_hash) DO UPDATE SET failures = CASE WHEN window_start = excluded.window_start THEN failures + 1 ELSE 1 END,
        window_start = excluded.window_start RETURNING failures`).bind(hash, start),
    ]);
    if (results[1].results[0].failures > MAX_TRIES) return login ? redirect(`/login?err=2&next=${encodeURIComponent(next)}`) : json({ error: "尝试太多，请稍后再试" }, 429);
    if (login && auth.check(ip, body.password)) {
      await db.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").bind(hash).run();
      return redirect(next, auth.setCookie(secure));
    }
    if (login) return redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
  }
  if (path === "/logout") return redirect("/login", auth.clearCookie(secure));
  if (method === "GET" && (path === "/" || path.endsWith(".html"))) return redirect(`/login?next=${encodeURIComponent(path + url.search)}`);
  return json({ error: "需要先登录" }, 401);
}
