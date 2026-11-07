import { fetchCanvasDirect } from "../canvas/direct.mjs";
import { applySync } from "../canvas/merge.mjs";
import { openD1 } from "./store.mjs";

const running = new WeakMap();
export const syncing = (env) => running.has(env);
export function syncCanvas(env) {
  if (running.has(env)) return running.get(env);
  const promise = run(env).finally(() => running.delete(env));
  running.set(env, promise);
  return promise;
}

async function run(env) {
  const store = openD1(env.DB), at = new Date().toISOString();
  try {
    if (!env.CANVAS_HOST || !env.CANVAS_TOKEN) throw new Error("未设置 CANVAS_HOST 和 CANVAS_TOKEN");
    const data = await fetchCanvasDirect(env.CANVAS_TOKEN, { host: env.CANVAS_HOST });
    let summary;
    await store.mutate((doc) => {
      const result = applySync(doc, data);
      summary = result.summary;
      return result.logs;
    }, "canvas-sync");
    const result = { ok: true, at, dryRun: false, courses: data.courses.length, ...summary };
    const brief = { courses: result.courses, added: result.added.length, updated: result.updated.length, done: result.done.length,
      conflicts: result.conflicts, gone: result.gone, failedCourses: result.failedCourses };
    await store.setMeta("canvasSync", { lastAttempt: at, lastSuccess: at, ok: true, error: null, result: brief });
    return result;
  } catch (err) {
    const error = err.message || String(err);
    await store.setMeta("canvasSync", { ...(await store.getMeta("canvasSync")), lastAttempt: at, ok: false, error });
    return { ok: false, at, error };
  }
}
