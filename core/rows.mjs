// Shared SQLite row mapping and row-level changes for Node and Cloudflare D1.
import { normalize } from "./schema.mjs";

// ---- The document and its rows ----

// The tables that hold the document, parents before children (rows are inserted in this order and deleted in reverse, as the
// foreign keys require), each with the columns of its primary key; meta holds the document's DOC_META keys among others
export const KEYS = { sections: ["id"], cards: ["id"], items: ["id"], check_ins: ["item_id", "day"], places: ["name"], meta: ["key"] };
export const DOC_META = ["rev", "updatedAt", "theme", "settings", "extras"];
export const NONE = Object.fromEntries(Object.keys(KEYS).map((t) => [t, []]));

// An optional field is a NULL column when the object does not have it, and is left out of the object when read back
const bit = (b) => (b == null ? null : b ? 1 : 0);
const flag = (n) => (n === null ? null : !!n);
const json = (v) => (v == null ? null : JSON.stringify(v));
const row = (r) => { for (const k in r) r[k] ??= null; return r; };
const present = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/** A normalized document → its rows, table by table */
export function rowsOf(doc) {
  return {
    sections: doc.sections.map((s) => row({ id: s.id, title: s.title, sub: s.sub, note: s.note, hidden: bit(s.hidden), position: s.order })),
    cards: doc.groups.map((g) => row({ id: g.id, section_id: g.section, title: g.title, note: g.note, plain: bit(g.plain), position: g.order })),
    items: doc.items.map((i) => row({
      id: i.id, card_id: i.group, title: i.title, note: i.note, status: i.status, position: i.order,
      created_at: i.createdAt, updated_at: i.updatedAt, done_at: i.doneAt, due: i.due, reason: i.reason, waiting_on: i.waitingOn,
      repeat_days: json(i.repeat?.days), repeat_time: i.repeat?.time,
      agent_where: i.agent?.where, agent_note: i.agent?.note, agent_since: i.agent?.since, agent_last_seen: i.agent?.lastSeen,
      source: json(i.source),
    })),
    check_ins: doc.items.flatMap((i) => (i.doneDates ?? []).map((day) => ({ item_id: i.id, day }))),
    places: doc.places.map((p) => row({ name: p.name, last_used: p.lastUsed, uses: p.uses, added_at: p.addedAt })),
    meta: DOC_META.map((key) => ({ key, value: JSON.stringify(doc[key]) })),
  };
}

/** Rows → the normalized document. An item has agent when any agent column is set, repeat when repeat_days is set, doneDates
 *  when it has check-ins; a place always has lastUsed and uses */
export function docOf(rows) {
  const meta = Object.fromEntries(rows.meta.map((r) => [r.key, JSON.parse(r.value)]));
  const days = Map.groupBy(rows.check_ins, (r) => r.item_id);
  return normalize({
    version: 2, rev: meta.rev, updatedAt: meta.updatedAt,
    sections: rows.sections.map((r) => present({ id: r.id, title: r.title, sub: r.sub, note: r.note, hidden: flag(r.hidden), order: r.position })),
    groups: rows.cards.map((r) => present({ id: r.id, section: r.section_id, title: r.title, note: r.note, plain: flag(r.plain), order: r.position })),
    items: rows.items.map((r) => {
      const agent = present({ where: r.agent_where, note: r.agent_note, since: r.agent_since, lastSeen: r.agent_last_seen });
      return present({
        id: r.id, group: r.card_id, title: r.title, status: r.status, note: r.note, order: r.position,
        createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at, due: r.due, reason: r.reason, waitingOn: r.waiting_on,
        repeat: r.repeat_days && present({ days: JSON.parse(r.repeat_days), time: r.repeat_time }),
        agent: Object.keys(agent).length ? agent : null,
        doneDates: days.get(r.id)?.map((c) => c.day),
        source: r.source && JSON.parse(r.source),
      });
    }),
    places: rows.places.map((r) => ({ name: r.name, lastUsed: r.last_used, uses: r.uses, ...present({ addedAt: r.added_at }) })),
    extras: meta.extras, theme: meta.theme, settings: meta.settings,
  });
}

/** SQL changes in foreign-key-safe order; values stay bound parameters. */
export function rowChanges(before, after) {
    const statements = [];
    const sql = (text) => ({ run: (...params) => statements.push({ text, params }) });
    const id = (t, r) => JSON.stringify(KEYS[t].map((k) => r[k]));
    const where = (t) => KEYS[t].map((k) => `${k} = ?`).join(" AND ");
    for (const t of Object.keys(KEYS)) {
      const old = new Map(before[t].map((r) => [id(t, r), r]));
      for (const r of after[t]) {
        const cols = Object.keys(r), was = old.get(id(t, r));
        if (!was) sql(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(r));
        else if (cols.some((c) => r[c] !== was[c])) {
          const set = cols.filter((c) => !KEYS[t].includes(c));
          sql(`UPDATE ${t} SET ${set.map((c) => `${c} = ?`).join(", ")} WHERE ${where(t)}`).run(...set.map((c) => r[c]), ...KEYS[t].map((k) => r[k]));
        }
      }
    }
    for (const t of Object.keys(KEYS).reverse()) {
      const kept = new Set(after[t].map((r) => id(t, r)));
      for (const r of before[t]) if (!kept.has(id(t, r))) sql(`DELETE FROM ${t} WHERE ${where(t)}`).run(...KEYS[t].map((k) => r[k]));
    }
    return statements;
}
