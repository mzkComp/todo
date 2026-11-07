// How Canvas assignments are merged into the board (pure functions; the tests call applySync directly). Reading Canvas is in
// read.mjs; running a sync and recording its state is in ../canvas-sync.mjs.
//
// Rules:
// - Import only assignments that are not submitted yet and can still be submitted: locked ones, ones more than two weeks past
//   their due date, unpublished ones and ones that take no submission (submission_types none / not_graded) are not imported.
//   An assignment is recognized by source.key (canvas:<host>:assignment:<id>), never guessed from its title.
// - Change only the facts that come from Canvas: title, due date, link, submission state. Status, note, agent details and
//   which card the item is on are never touched.
// - A title or due date edited by hand (different from the last import) is not overwritten, only reported in the result.
// - When Canvas shows an assignment as submitted, graded or excused, its item is marked done; items closed by hand are never
//   reopened.
// - When a course could not be fetched, none of its items change; items no longer found on Canvas are not deleted either,
//   only reported.
// - Synced items deleted on the board are remembered in extras.canvasDismissed (rememberDismissed in core/items.mjs) and
//   never imported again.
import { newId, nextOrder } from "../core/doc.mjs";
import { applyPatch } from "../core/items.mjs";
import { addSection } from "../core/board.mjs";
import { OPEN, itemsOf } from "../web/lib/model.js";
import { pad2 } from "../web/lib/due.js";

const STALE_DAYS = 14, DAY = 86_400_000;
const FINISHED = new Set(["submitted", "graded", "pending_review", "complete"]);

/** A Canvas ISO time → the board's due date format in local time, "2026-10-28 23:59" */
export function localDue(iso) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// For sorting: accepts ISO, "2026-10-28 23:59" and "2026-10-28"; anything unrecognized sorts last
function dueMs(s) {
  if (!s) return Infinity;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(s).trim());
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], m[4] == null ? 23 : +m[4], m[5] == null ? 59 : +m[5]).getTime();
  const t = Date.parse(s);
  return Number.isNaN(t) ? Infinity : t;
}
const finished = (a) => !!a.excused || !!a.submitted_at || FINISHED.has(a.workflow_state);
const stateOf = (a) => (a.excused ? "excused" : a.workflow_state || "unsubmitted");
const titleOf = (c, a) => `${c.name} · ${a.name}`;

function actionable(a, now) {
  if (a.published === false) return false;
  const types = a.submission_types ?? [];
  if (types.length && types.every((t) => t === "none" || t === "not_graded")) return false;
  if (Date.parse(a.lock_at ?? "") <= now) return false;
  if (Date.parse(a.due_at ?? "") < now - STALE_DAYS * DAY) return false;
  return true;
}

/** Which card synced items go to: the one chosen in the settings, else an existing card with the built-in courses title, else
 *  a new section with that title. A card found or created this way is saved in the settings. */
function targetGroup(doc, logs) {
  const want = doc.settings.canvasGroup;
  let g = want ? doc.groups.find((x) => x.id === want) : null;
  if (g) return g;
  g = doc.groups.find((x) => x.title === "课程");
  if (!g) {
    const log = addSection(doc, { title: "课程" });
    logs.push(log);
    g = doc.groups.find((x) => x.section === log.id);
  }
  doc.settings.canvasGroup = g.id;
  logs.push({ op: "settings", keys: ["canvasGroup"] });
  return g;
}

// Insert by due date: before the first item in the card that is due later
function orderFor(doc, g, due) {
  const at = dueMs(due);
  let prev = null;
  for (const x of itemsOf(doc, g.id)) {
    if (dueMs(x.due) > at) return prev ? (prev.order + x.order) / 2 : x.order - 10;
    prev = x;
  }
  return nextOrder(itemsOf(doc, g.id));
}

function add(doc, g, { key, c, a }, now, logs, summary) {
  const t = new Date(now).toISOString(), due = localDue(a.due_at), title = titleOf(c, a);
  const item = {
    id: newId(), group: g.id, title, status: "todo", note: "", order: orderFor(doc, g, due), createdAt: t, updatedAt: t,
    source: { type: "canvas", key, id: a.id, courseId: c.id, course: c.name, url: a.html_url ?? "", title, state: stateOf(a) },
  };
  if (due) { item.due = due; item.source.due = due; }
  doc.items.push(item);
  summary.added.push({ id: item.id, title, due });
  logs.push({ op: "canvas-add", id: item.id, title, key });
}

function update(item, c, a, now, logs, summary) {
  const src = item.source, changes = {}, quiet = {};
  const title = titleOf(c, a), due = localDue(a.due_at);
  // Title and due date follow Canvas only while the item still has the last imported value; if it was edited by hand, the
  // edit stays and a conflict is reported once
  if (title !== src.title) {
    if (item.title === src.title) { changes.title = [item.title, title]; item.title = title; }
    else summary.conflicts.push({ id: item.id, title: item.title, field: "标题", mine: item.title, canvas: title });
    src.title = title;
  }
  if (due !== (src.due ?? null)) {
    if ((item.due ?? null) === (src.due ?? null)) {
      changes.due = [item.due ?? null, due];
      if (due) item.due = due; else delete item.due;
    } else summary.conflicts.push({ id: item.id, title: item.title, field: "截止", mine: item.due ?? "无", canvas: due ?? "无" });
    if (due) src.due = due; else delete src.due;
  }
  // Not shown on the board: link, course name, submission state
  for (const [k, v] of [["url", a.html_url ?? ""], ["course", c.name], ["courseId", c.id], ["state", stateOf(a)]]) {
    if (src[k] !== v) { quiet[k] = [src[k] ?? null, v]; src[k] = v; }
  }
  if (finished(a) && OPEN.includes(item.status) && !item.repeat?.days?.length) {
    Object.assign(changes, applyPatch(item, { status: "done" }));
    summary.done.push({ id: item.id, title: item.title });
  }
  if (!Object.keys(changes).length && !Object.keys(quiet).length) return;
  item.updatedAt = new Date(now).toISOString();
  const fields = [changes.title && "标题", changes.due && "截止"].filter(Boolean);
  if (fields.length) summary.updated.push({ id: item.id, title: item.title, fields });
  logs.push({ op: "canvas-update", id: item.id, title: item.title, changes: { ...changes, ...quiet } });
}

/** Merges a Canvas export into doc. Returns { logs, summary }; empty logs mean nothing changed. */
export function applySync(doc, data, now = Date.now()) {
  const logs = [], summary = { added: [], updated: [], done: [], conflicts: [], gone: [], failedCourses: [] };
  doc.extras ??= {};
  doc.settings ??= {};
  const dismissed = new Set(doc.extras.canvasDismissed ?? []);
  const byKey = new Map(doc.items.filter((i) => i.source?.type === "canvas").map((i) => [i.source.key, i]));
  const okCourses = new Set(), seen = new Set(), fresh = [];
  for (const c of data.courses) {
    if (!c.ok) { summary.failedCourses.push({ name: c.name, error: c.error ?? "没拉到" }); continue; }
    okCourses.add(c.id);
    for (const a of c.assignments) {
      const key = `canvas:${data.host}:assignment:${a.id}`;
      seen.add(key);
      const item = byKey.get(key);
      if (item) update(item, c, a, now, logs, summary);
      else if (!dismissed.has(key) && !finished(a) && actionable(a, now)) fresh.push({ key, c, a });
    }
  }
  // There is always a card: the sync button sits on the left of its section
  const g = targetGroup(doc, logs);
  fresh.sort((x, y) => dueMs(x.a.due_at) - dueMs(y.a.due_at));
  for (const f of fresh) add(doc, g, f, now, logs, summary);
  for (const [key, item] of byKey) {
    if (!seen.has(key) && okCourses.has(item.source.courseId) && OPEN.includes(item.status)) summary.gone.push({ id: item.id, title: item.title });
  }
  return { logs, summary };
}
