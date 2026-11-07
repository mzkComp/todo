// Places where items are handed off to agents: sorted by most recent use (LRU); they can also be added, renamed and deleted by
// hand. doc.places = [{ name, lastUsed, uses, addedAt? }]. Handing an item off to an agent, or changing where it runs, adds 1 to
// uses and sets lastUsed to now (applyPatch in items.mjs calls touchPlace); a place added in the settings and not used yet has
// an empty lastUsed and sorts by addedAt. The sorting is in web/lib/places.js (the browser uses it too).
import { invalid } from "./errors.mjs";
import { nowIso } from "./doc.mjs";

/** Records one use (an item handed off, or its place changed); a name not seen before is added along the way */
export function touchPlace(doc, name, t = nowIso()) {
  name = String(name ?? "").trim();
  if (!name) return null;
  doc.places ??= [];
  let p = doc.places.find((x) => x.name === name);
  if (!p) doc.places.push((p = { name, lastUsed: null, uses: 0 }));
  p.uses = (p.uses ?? 0) + 1;
  p.lastUsed = t;
  return p;
}

// The three below are operations from the board's settings: they change doc and return one log entry (null when nothing changed)

export function addPlace(doc, name) {
  name = String(name ?? "").trim();
  if (!name) throw invalid("要有名字");
  doc.places ??= [];
  if (doc.places.some((p) => p.name === name)) return null;
  doc.places.push({ name, lastUsed: null, uses: 0, addedAt: nowIso() });
  return { op: "add-place", name };
}

/** Renames a place, merging it into an existing place of the same name; items under the old name change with it */
export function renamePlace(doc, from, to) {
  from = String(from ?? "").trim(); to = String(to ?? "").trim();
  if (!from || !to || from === to) return null;
  const a = (doc.places ?? []).find((x) => x.name === from);
  if (!a) return null;
  const b = doc.places.find((x) => x.name === to);
  if (b) {
    b.uses = (b.uses ?? 0) + (a.uses ?? 0);
    if ((a.lastUsed ?? "") > (b.lastUsed ?? "")) b.lastUsed = a.lastUsed;
    doc.places = doc.places.filter((x) => x !== a);
  } else a.name = to;
  for (const i of doc.items) if (i.agent?.where?.trim() === from) i.agent.where = to;
  return { op: "rename-place", from, to };
}

/** Deletes a place (items handed off there stay as they are; it just no longer appears among the choices) */
export function deletePlace(doc, name) {
  const n = (doc.places ?? []).length;
  doc.places = (doc.places ?? []).filter((p) => p.name !== name);
  return doc.places.length < n ? { op: "delete-place", name } : null;
}
