// Storage: the board, its log and the state of the Canvas sync, in one SQLite file in the data directory (TODO_DIR, default
// ./data): todo.db, through Node's built-in node:sqlite. The business rules never see the database: they change a plain
// document (see doc.mjs), and this file maps the document to tables and back. Every change goes through mutate(): in one
// transaction it reads the board, lets fn change the document, and writes back only the rows that changed, with the log entries
// fn returns. data.mjs exports and imports the board on the command line.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "./doc.mjs";
import { normalize } from "./schema.mjs";
import { DOC_META, NONE, rowsOf, docOf, rowChanges } from "./rows.mjs";

export const dataDir = () => process.env.TODO_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "data");

// The schema, versioned with PRAGMA user_version: step n takes a database from version n to n + 1, so a change to the schema is
// a step added at the end. The document calls cards groups (item.group, group.section) and positions order; check_ins holds
// item.doneDates; meta holds rev, updatedAt, and as JSON theme, settings, extras and the Canvas sync state (canvasSync).
const MIGRATIONS = [`
  CREATE TABLE sections (id TEXT PRIMARY KEY, title TEXT NOT NULL, sub TEXT, note TEXT, hidden INTEGER, position REAL NOT NULL);
  CREATE TABLE cards (id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id), title TEXT NOT NULL, note TEXT,
    plain INTEGER, position REAL NOT NULL);
  CREATE TABLE items (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), title TEXT NOT NULL, note TEXT,
    status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'agent', 'waiting', 'done', 'dropped')), position REAL NOT NULL,
    created_at TEXT, updated_at TEXT, done_at TEXT, due TEXT, reason TEXT, waiting_on TEXT,
    repeat_days TEXT, repeat_time TEXT, -- repeat_days: a JSON array of weekdays
    agent_where TEXT, agent_note TEXT, agent_since TEXT, agent_last_seen TEXT,
    source TEXT); -- JSON: where a synced item came from (canvas/merge.mjs)
  CREATE TABLE check_ins (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, day TEXT NOT NULL, PRIMARY KEY (item_id, day));
  CREATE TABLE places (name TEXT PRIMARY KEY, last_used TEXT, uses INTEGER NOT NULL, added_at TEXT);
  CREATE TABLE log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL, entry TEXT NOT NULL); -- entry: JSON of the rest
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- value: JSON
  CREATE INDEX cards_by_section ON cards (section_id);
  CREATE INDEX items_by_card ON items (card_id);
`];

// ---- The store: one connection per process and data directory ----

const stores = new Map();

/** The store of a data directory: the functions below, over one connection that the first call for that directory opens (later
 *  calls get the same store, until close) */
export function openStore(dir = dataDir()) {
  const path = resolve(dir);
  if (stores.has(path)) return stores.get(path);
  mkdirSync(path, { recursive: true });
  const db = new DatabaseSync(join(path, "todo.db"));
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  // Switching a new database to WAL fails at once, without waiting, while another process is switching it at the same moment;
  // then wait a little and try again (by then it is in WAL mode, and switching does nothing)
  for (let waited = 0; ; waited += 20) {
    try { db.exec("PRAGMA journal_mode = WAL"); break; } catch (err) {
      if (err.errcode !== 5 || waited >= 5000) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const cache = new Map(), sql = (text) => cache.get(text) ?? cache.set(text, db.prepare(text)).get(text);

  // BEGIN IMMEDIATE takes the write lock at the start: another process waits for it (busy_timeout) rather than failing halfway.
  // fn may end the transaction itself with ROLLBACK
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (db.isTransaction) db.exec("COMMIT");
      return result;
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  }
  const version = () => db.prepare("PRAGMA user_version").get().user_version;
  if (version() < MIGRATIONS.length) transaction(() => {
    for (let v = version(); v < MIGRATIONS.length; v++) db.exec(`${MIGRATIONS[v]}; PRAGMA user_version = ${v + 1}`);
  });

  // The rows of the document, in the order they were added (rowid), which is the order of the document's arrays
  const readRows = () => ({
    sections: sql("SELECT * FROM sections ORDER BY rowid").all(),
    cards: sql("SELECT * FROM cards ORDER BY rowid").all(),
    items: sql("SELECT * FROM items ORDER BY rowid").all(),
    check_ins: sql("SELECT * FROM check_ins ORDER BY day").all(),
    places: sql("SELECT * FROM places ORDER BY rowid").all(),
    meta: sql(`SELECT * FROM meta WHERE key IN (${DOC_META.map(() => "?").join(", ")})`).all(...DOC_META),
  });

  /** Writes what differs between the rows in the database and the rows wanted */
  function write(before, after) {
    for (const { text, params } of rowChanges(before, after)) sql(text).run(...params);
  }
  const addLog = (ts, actor, op, rest) => sql("INSERT INTO log (ts, actor, op, entry) VALUES (?, ?, ?, ?)").run(ts, actor, op, JSON.stringify(rest));

  /** The normalized document; an empty board (rev 0) when the database is new */
  function load() {
    db.exec("BEGIN"); // one snapshot of all the tables
    try { return docOf(readRows()); } finally { db.exec("COMMIT"); }
  }

  /** Reads the latest board and lets fn change it. fn returns the log entries (one, several, or null when nothing changed); they
   *  are written with the rows that changed, in one transaction. fn must be synchronous: a transaction cannot stay open across an
   *  await, since everything in the process shares this connection */
  function mutate(fn, actor = "unknown") {
    return transaction(() => {
      const before = readRows(), doc = docOf(before);
      const out = fn(doc);
      if (out instanceof Promise) throw new Error("mutate: fn returned a promise; it must change the document synchronously");
      const logs = [out].flat().filter(Boolean);
      if (!logs.length) { db.exec("ROLLBACK"); return docOf(before); } // nothing changed: nothing is written, and rev stays the same
      doc.rev += 1;
      doc.updatedAt = nowIso();
      const after = rowsOf(normalize(doc));
      write(before, after);
      for (const { op, ...rest } of logs) addLog(doc.updatedAt, actor, op, rest);
      return docOf(after);
    });
  }

  /** Replaces the whole board, and the log too if one is given (entries as readLog returns them); for data.mjs import */
  function replaceAll(doc, { log } = {}) {
    transaction(() => {
      write(readRows(), NONE);
      write(NONE, rowsOf(normalize(structuredClone(doc))));
      if (log) {
        sql("DELETE FROM log").run();
        for (const { ts, actor, op, ...rest } of log) addLog(ts, actor, op, rest);
      }
    });
  }

  /** Every log entry, oldest first: { ts, actor, op, ... } */
  const readLog = () => sql("SELECT * FROM log ORDER BY id").all().map((r) => ({ ts: r.ts, actor: r.actor, op: r.op, ...JSON.parse(r.entry) }));

  // State kept next to the board that is not part of it (the Canvas sync's): reading or writing it does not touch rev
  const getMeta = (key) => { const r = sql("SELECT value FROM meta WHERE key = ?").get(key); return r && JSON.parse(r.value); };
  const setMeta = (key, value) => { sql("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(value)); };

  function close() {
    stores.delete(path);
    db.close();
  }

  const store = { load, mutate, replaceAll, readLog, getMeta, setMeta, close };
  stores.set(path, store);
  return store;
}

// The same functions for the data directory in TODO_DIR (what the server, Canvas sync and data.mjs use)
const store = () => openStore(dataDir());
export const load = () => store().load();
export const mutate = (fn, actor) => store().mutate(fn, actor);
export const replaceAll = (doc, opts) => store().replaceAll(doc, opts);
export const readLog = () => store().readLog();
export const getMeta = (key) => store().getMeta(key);
export const setMeta = (key, value) => store().setMeta(key, value);
