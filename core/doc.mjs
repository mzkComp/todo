// Small helpers for finding things in a document (doc) and putting them in order; the other core modules all use them.
// doc = { sections, groups, items, places, theme, settings, extras, rev, updatedAt }; sections, cards and items each have an
// order, smaller first
import { invalid, notFound } from "./errors.mjs";

export const nowIso = () => new Date().toISOString();
export const newId = (prefix = "t") => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
/** The order value that puts an entry last */
export const nextOrder = (xs) => (xs.length ? Math.max(...xs.map((x) => x.order ?? 0)) + 10 : 10);

/** Moves one entry up or down by one place among its siblings (swapping order). Returns false if it cannot move (already
 *  first or last) */
export function moveIn(list, id, dir) {
  needDir(dir);
  const xs = [...list].sort(byOrder);
  const i = xs.findIndex((x) => x.id === id);
  const j = i + (dir === "up" ? -1 : 1);
  if (i < 0 || j < 0 || j >= xs.length) return false;
  const a = xs[i].order, b = xs[j].order;
  xs[i].order = b === a ? a + (dir === "up" ? -1 : 1) : b;
  xs[j].order = a;
  return true;
}
function needDir(dir) {
  if (dir !== "up" && dir !== "down") throw invalid(`dir 要么 up 要么 down：${dir}`);
}

// Look up by id, 404 if missing (everything clicked on the board carries an id)
const must = (x, msg) => { if (!x) throw notFound(msg); return x; };
export const getItem = (doc, id) => must(doc.items.find((i) => i.id === id), `没有这一条：${id}`);
export const getGroup = (doc, id) => must(doc.groups.find((g) => g.id === id), `没有这个分组：${id}`);
export const getSection = (doc, id) => must(doc.sections.find((s) => s.id === id), `没有这个分区：${id}`);

// Find by id or by a piece of the title (agents mostly pass a piece of the title)
export function findItem(doc, ref) {
  if (!ref) return undefined;
  const byId = doc.items.find((i) => i.id === ref);
  if (byId) return byId;
  const hits = doc.items.filter((i) => i.title.includes(ref));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw invalid(`“${ref}”匹配到多条：${hits.map((h) => `${h.id}（${h.title}）`).join("，")}`);
  return undefined;
}
export function findGroup(doc, ref) {
  if (!ref) return undefined;
  return doc.groups.find((g) => g.id === ref) ?? doc.groups.find((g) => g.title.includes(ref));
}
