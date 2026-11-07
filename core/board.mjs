// The board's structure: sections (the large blocks on the page, such as "Work" or "Life") and cards (groups in the code: one
// line of work, or one set of things within a section), plus the appearance (theme), settings and yearly goals (extras).
// Each operation changes the doc passed in and returns one log entry (null when nothing changed); reading, writing and locking
// happen in mutate in store.mjs.
import { fail, invalid } from "./errors.mjs";
import { newId, nextOrder, moveIn, getGroup, getSection } from "./doc.mjs";
import { rememberDismissed } from "./items.mjs";
import { DEFAULT_THEME, DEFAULT_SETTINGS } from "./schema.mjs";
import { groupsOf } from "../web/lib/model.js";

const needTitle = (b) => {
  const t = String(b.title ?? "").trim();
  if (!t) throw invalid("要有标题");
  return t;
};
const noEmptyTitle = (b) => { if (b.title !== undefined && !String(b.title).trim()) throw invalid("标题不能是空的"); };
const needSection = (doc, id) => { if (!doc.sections.some((s) => s.id === id)) throw invalid(`没有这个分区：${id}`); };
// Writes the fields given in b that differ from obj into obj; returns { field: [old, new] }
function assign(obj, b, keys) {
  const changes = {};
  for (const k of keys) if (b[k] !== undefined && b[k] !== obj[k]) { changes[k] = [obj[k], b[k]]; obj[k] = b[k]; }
  return changes;
}
const logIf = (entry, changes) => (Object.keys(changes).length ? { ...entry, changes } : null);

// ---- Cards ----

export function addGroup(doc, b) {
  const title = needTitle(b);
  needSection(doc, b.section);
  const g = { id: newId("g"), section: b.section, title, note: b.note ?? "", order: nextOrder(groupsOf(doc, b.section)) };
  doc.groups.push(g);
  return { op: "add-group", id: g.id, title: g.title, section: g.section };
}

/** Renames the card, changes its note, or moves it to another section (last in that section) */
export function updateGroup(doc, id, b) {
  const g = getGroup(doc, id);
  noEmptyTitle(b);
  const changes = assign(g, b, ["title", "note"]);
  const moving = b.section !== undefined && b.section !== g.section;
  // The card a new section comes with (plain) shows no title of its own; once it gets a name of its own or moves to another
  // section, it is no longer plain
  if (changes.title || moving) delete g.plain;
  if (moving) {
    needSection(doc, b.section);
    changes.section = [g.section, b.section];
    g.section = b.section;
    g.order = nextOrder(groupsOf(doc, b.section).filter((x) => x.id !== g.id));
  }
  return logIf({ op: "update-group", id }, changes);
}

/** A card that still has items is deleted only with force (its items are deleted with it) */
export function deleteGroup(doc, id, { force } = {}) {
  const g = getGroup(doc, id);
  const items = doc.items.filter((i) => i.group === id);
  if (items.length && !force) throw fail(409, `这一组里还有 ${items.length} 条，先挪走或删掉`);
  rememberDismissed(doc, items);
  doc.items = doc.items.filter((i) => i.group !== id);
  doc.groups = doc.groups.filter((x) => x.id !== id);
  return { op: "delete-group", id, title: g.title, items: items.length };
}

export function moveGroup(doc, id, { dir } = {}) {
  const g = getGroup(doc, id);
  return moveIn(groupsOf(doc, g.section), id, dir) ? { op: "move-group", id, dir } : null;
}

// ---- Sections ----

/** A new section comes with one empty card (plain: it shows no title of its own and takes the section's name), so items can be
 *  added right away */
export function addSection(doc, b) {
  const title = needTitle(b);
  const s = { id: newId("s"), title, sub: b.sub ?? "", note: b.note ?? "", order: nextOrder(doc.sections), hidden: false };
  doc.sections.push(s);
  doc.groups.push({ id: newId("g"), section: s.id, title: s.title, note: "", order: 10, plain: true });
  return { op: "add-section", id: s.id, title: s.title };
}

export function updateSection(doc, id, b) {
  const s = getSection(doc, id);
  noEmptyTitle(b);
  const changes = assign(s, b, ["title", "sub", "note", "hidden"]);
  if (changes.title) for (const g of doc.groups) if (g.section === id && g.plain) g.title = s.title;
  return logIf({ op: "update-section", id }, changes);
}

export function deleteSection(doc, id, { force } = {}) {
  const s = getSection(doc, id);
  const gids = new Set(doc.groups.filter((g) => g.section === id).map((g) => g.id));
  const items = doc.items.filter((i) => gids.has(i.group));
  if (items.length && !force) throw fail(409, `这一块里还有 ${items.length} 条，先挪走或删掉`);
  rememberDismissed(doc, items);
  doc.items = doc.items.filter((i) => !gids.has(i.group));
  doc.groups = doc.groups.filter((g) => g.section !== id);
  doc.sections = doc.sections.filter((x) => x.id !== id);
  return { op: "delete-section", id, title: s.title, items: items.length };
}

export function moveSection(doc, id, { dir } = {}) {
  getSection(doc, id);
  return moveIn(doc.sections, id, dir) ? { op: "move-section", id, dir } : null;
}

// ---- Appearance, settings, yearly goals: only known fields are accepted; unchanged values do nothing (no write, no log) ----

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const changedOnly = (cur, patch) => Object.fromEntries(Object.entries(patch).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(cur?.[k])));
function merge(doc, key, patch, op) {
  const c = changedOnly(doc[key], patch);
  if (!Object.keys(c).length) return null;
  doc[key] = { ...doc[key], ...c };
  return { op, keys: Object.keys(c) };
}

/** { reset: true } restores the default appearance (the content stays as it is) */
export function patchTheme(doc, b) {
  if (b.reset) { doc.theme = { ...DEFAULT_THEME }; return { op: "theme", keys: ["reset"] }; }
  return merge(doc, "theme", pick(b, Object.keys(DEFAULT_THEME)), "theme");
}
export const patchSettings = (doc, b) => merge(doc, "settings", pick(b, Object.keys(DEFAULT_SETTINGS)), "settings");

export function patchExtras(doc, b) {
  const next = {};
  if (b.yearGoalsTitle !== undefined) next.yearGoalsTitle = String(b.yearGoalsTitle);
  if (Array.isArray(b.yearGoals)) next.yearGoals = b.yearGoals.map(String).filter((x) => x.trim());
  return merge(doc, "extras", next, "extras");
}
