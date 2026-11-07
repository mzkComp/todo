import { EDITS, match } from "../core/edits.mjs";
import { normalize } from "../core/schema.mjs";
import { openD1 } from "./store.mjs";
import { authenticate } from "./auth.mjs";
import { json, readBody, secureResponse } from "./http.mjs";
import { syncCanvas, syncing } from "./canvas.mjs";

const ACTORS = new Set(["pi", "canvas-sync", "assistant"]);

export default {
  async fetch(request, env) {
    let response;
    try {
      const url = new URL(request.url), method = request.method, path = url.pathname;
      const origin = request.headers.get("origin");
      if (env.TODO_PUBLIC_HOST && url.host !== env.TODO_PUBLIC_HOST) response = json({ error: "不接受此域名" }, 403);
      else if (!["GET", "HEAD"].includes(method) && origin && origin !== url.origin) response = json({ error: "不接受跨站修改" }, 403);
      else {
        const store = openD1(env.DB);
        response = await authenticate(request, env, store);
        if (!response) {
          if (method === "GET" && path === "/api/health") response = json({ ok: true });
          else if (method === "GET" && path === "/api/todo") response = json(await store.load());
          else if (method === "GET" && path === "/api/canvas") response = json({ ...(await store.getMeta("canvasSync")), running: syncing(env) });
          else if (method === "POST" && path === "/api/canvas/sync") {
            const result = await syncCanvas(env);
            response = result.ok ? json(result) : json({ error: result.error }, 502);
          } else if ((method === "GET" || method === "HEAD") && !path.startsWith("/api/")) response = await env.ASSETS.fetch(request);
          else {
            const edit = match(EDITS, method, path);
            if (!edit) response = json({ error: "not found" }, 404);
            else {
              const body = await readBody(request), givenActor = request.headers.get("x-actor");
              const actor = ACTORS.has(givenActor) ? givenActor : "board";
              response = json(normalize(await store.mutate((doc) => edit.fn(doc, body, edit.id), actor)));
            }
          }
        }
      }
    } catch (err) {
      const code = typeof err.code === "number" && err.code >= 400 && err.code < 600 ? err.code : 500;
      if (code === 500) console.error(err);
      response = json({ error: code === 500 ? "服务暂时出错，请检查数据库迁移及 Worker 日志" : err.message }, code);
    }
    return secureResponse(response, request);
  },
  async scheduled(_event, env) {
    if (env.CANVAS_HOST && env.CANVAS_TOKEN) {
      const result = await syncCanvas(env);
      if (!result.ok) throw new Error(result.error);
    }
  },
};
