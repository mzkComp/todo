// The table of endpoints that change data: one line per endpoint. Each receives (doc, body, id), has an operation from core
// change doc, and returns one log entry (null when nothing changed).
// Two places use the same table: the server (server.mjs reads, changes and writes in one transaction and records who made the
// change; see server/routes.mjs), and the demo site (demo/backend.js), which runs it on a copy of the data in the browser. So
// neither this file nor the modules it uses may touch anything from Node (storage lives in store.mjs).
import { addItem, updateItem, deleteItem, checkItem, moveItem } from "./items.mjs";
import { addGroup, updateGroup, deleteGroup, moveGroup, addSection, updateSection, deleteSection, moveSection, patchTheme, patchSettings, patchExtras } from "./board.mjs";
import { addPlace, renamePlace, deletePlace } from "./places.mjs";

export const EDITS = {
  // Items
  "POST /api/items": (d, b) => addItem(d, b),
  "PATCH /api/items/:id": (d, b, id) => updateItem(d, id, b),
  "DELETE /api/items/:id": (d, _b, id) => deleteItem(d, id),
  "POST /api/items/:id/check": (d, b, id) => checkItem(d, id, b), // check-in for a recurring item: { date, done }
  "POST /api/items/:id/move": (d, b, id) => moveItem(d, id, b), // { dir: up | down, within: open }
  // Cards (groups)
  "POST /api/groups": (d, b) => addGroup(d, b),
  "PATCH /api/groups/:id": (d, b, id) => updateGroup(d, id, b),
  "DELETE /api/groups/:id": (d, b, id) => deleteGroup(d, id, b), // { force: true } deletes the items in it too
  "POST /api/groups/:id/move": (d, b, id) => moveGroup(d, id, b),
  // Sections
  "POST /api/sections": (d, b) => addSection(d, b),
  "PATCH /api/sections/:id": (d, b, id) => updateSection(d, id, b),
  "DELETE /api/sections/:id": (d, b, id) => deleteSection(d, id, b),
  "POST /api/sections/:id/move": (d, b, id) => moveSection(d, id, b),
  // Places where items are handed off to agents
  "POST /api/places": (d, b) => addPlace(d, b.name),
  "PATCH /api/places": (d, b) => renamePlace(d, b.from, b.to),
  "DELETE /api/places": (d, b) => deletePlace(d, b.name),
  // Appearance, settings, yearly goals
  "PATCH /api/theme": (d, b) => patchTheme(d, b),
  "PATCH /api/settings": (d, b) => patchSettings(d, b),
  "PATCH /api/extras": (d, b) => patchExtras(d, b),
};

/** Finds the table entry for a request, taking :id out of the path */
export function match(table, method, pathname) {
  const q = pathname.split("/");
  for (const key of Object.keys(table)) {
    const [m, pattern] = key.split(" "), p = pattern.split("/");
    if (m !== method || p.length !== q.length) continue;
    let id;
    if (p.every((seg, i) => (seg === ":id" ? ((id = decodeURIComponent(q[i])), true) : seg === q[i]))) return { fn: table[key], id };
  }
  return null;
}
