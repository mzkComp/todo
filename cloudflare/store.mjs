// D1 adapter. Business operations and row mapping are shared with the Node server.
import { DOC_META, rowsOf, docOf, rowChanges } from "../core/rows.mjs";
import { normalize } from "../core/schema.mjs";
import { nowIso } from "../core/doc.mjs";
import { fail } from "../core/errors.mjs";

const READS = [
  ["sections", "SELECT * FROM sections ORDER BY rowid"],
  ["cards", "SELECT * FROM cards ORDER BY rowid"],
  ["items", "SELECT * FROM items ORDER BY rowid"],
  ["check_ins", "SELECT * FROM check_ins ORDER BY day"],
  ["places", "SELECT * FROM places ORDER BY rowid"],
  ["meta", `SELECT * FROM meta WHERE key IN (${DOC_META.map(() => "?").join(", ")})`, DOC_META],
];

export function openD1(binding) {
  // Reading a new request starts at the primary even when D1 replicas are enabled.
  const db = binding.withSession("first-primary");
  const sql = (text, params = []) => params.length ? db.prepare(text).bind(...params) : db.prepare(text);
  async function readRows() {
    const results = await db.batch(READS.map(([, text, params]) => sql(text, params)));
    return Object.fromEntries(READS.map(([table], i) => [table, results[i].results]));
  }

  async function mutate(fn, actor = "unknown") {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = await readRows(), doc = docOf(before), revision = String(doc.rev);
      const out = fn(doc);
      if (out instanceof Promise) throw new Error("mutate: fn must be synchronous");
      const logs = [out].flat().filter(Boolean);
      if (!logs.length) return docOf(before);
      doc.rev += 1;
      doc.updatedAt = nowIso();
      const after = rowsOf(normalize(doc));
      // A zero-row UPDATE would NOT abort a D1 batch. Setting a NOT NULL value
      // to NULL deliberately makes a stale revision fail and rolls back ALL
      // writes/logs in this batch. Retrying re-applies fn to the latest board.
      const guard = sql("UPDATE meta SET value = CASE WHEN value = ? THEN value ELSE NULL END WHERE key = 'rev'", [revision]);
      const changes = rowChanges(before, after).map(({ text, params }) => sql(text, params));
      const entries = logs.map(({ op, ...rest }) => sql("INSERT INTO log (ts, actor, op, entry) VALUES (?, ?, ?, ?)", [doc.updatedAt, actor, op, JSON.stringify(rest)]));
      try {
        await db.batch([guard, ...changes, ...entries]);
        return docOf(after);
      } catch (err) {
        const message = `${err.message} ${err.cause?.message ?? ""}`;
        if (!message.includes("NOT NULL constraint failed: meta.value")) throw err;
      }
    }
    throw fail(409, "同时修改的人太多，请重试");
  }

  return {
    load: async () => docOf(await readRows()),
    mutate,
    async getMeta(key) {
      const r = await sql("SELECT value FROM meta WHERE key = ?", [key]).first();
      return r ? JSON.parse(r.value) : undefined;
    },
    async setMeta(key, value) {
      if (DOC_META.includes(key)) throw new Error("Board metadata must go through mutate");
      await sql("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]).run();
    },
  };
}
