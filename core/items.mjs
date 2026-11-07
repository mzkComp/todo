// Items: add, change, delete, check in, move. The board's API, agents (through client.mjs) and Canvas sync all change items here.
// The ones the API uses (addItem, updateItem, deleteItem, checkItem, moveItem) change the doc passed in and return one log entry
// (null when nothing changed); reading, writing and locking happen in mutate in store.mjs. applyPatch is the layer below: it
// changes one item and returns which fields changed.
//
// Recurring items: item.repeat = { days: [1,2,3,4,5], time: "12:00" }, where days are JS weekdays (0 = Sunday) and time is when
// the day rolls over; item.doneDates = ["2026-10-20", ...] lists the days checked in. Whether an item is due today and whether it
// is done is worked out in web/lib/repeat.js (the same code the browser uses).
// Recurring items are never "done": setting done only records a check-in for today.
import { invalid } from "./errors.mjs";
import { nowIso, newId, nextOrder, moveIn, getItem, findGroup } from "./doc.mjs";
import { touchPlace } from "./places.mjs";
import { ORDER, OPEN, itemsOf } from "../web/lib/model.js";
import { WEEK, ymd } from "../web/lib/due.js";
import { repeatDay, repeatState } from "../web/lib/repeat.js";

// Due date, reason, waiting on: setting one to empty deletes the field, so no empty strings are left in the data
export const CLEARABLE = ["due", "reason", "waitingOn"];

/** Adds the year to a due date written as month and day only ("1-5", "1/5", "1.5", or the Chinese month-day form): a date more
 *  than 60 days in the past counts as next year. The completed date is what gets stored, so it no longer shifts as time passes */
export function fixDueYear(due, now = new Date()) {
  const m = /^(\d{1,2})[-/.](\d{1,2})(\s.*)?$/.exec(due) || /^(\d{1,2})月(\d{1,2})日?(\s.*)?$/.exec(due);
  if (!m) return due;
  const mo = Number(m[1]), d = Number(m[2]);
  let y = now.getFullYear();
  if (new Date(y, mo - 1, d) < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60)) y++;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}${m[3] ?? ""}`;
}

/** Normalizes the ways to write a repeat to { days, time } or null: an object, "daily", "weekdays", "weekends", "none",
 *  "1,3,5" (1 = Monday … 7 = Sunday), or the Chinese words for these, including a string of Chinese weekday numerals (one
 *  character per day) */
export function normalizeRepeat(r) {
  if (r == null || r === false || r === "" || r === "none") return null;
  let days, time = "";
  if (typeof r === "string") {
    const t = r.trim();
    if (/^(daily|每天)$/i.test(t)) days = [0, 1, 2, 3, 4, 5, 6];
    else if (/^(weekdays?|工作日)$/i.test(t)) days = [1, 2, 3, 4, 5];
    else if (/^(weekends?|周末)$/i.test(t)) days = [0, 6];
    else if (/^[1-7](\s*,\s*[1-7])*$/.test(t)) days = t.split(",").map((x) => Number(x) % 7);
    else if (/^[一二三四五六日天]+$/.test(t)) days = [...t].map((c) => (c === "天" ? 0 : WEEK.indexOf(c)));
    else throw invalid(`看不懂的重复写法：${r}`);
  } else if (typeof r === "object") {
    days = Array.isArray(r.days) ? r.days.map(Number) : [];
    time = typeof r.time === "string" ? r.time.trim() : "";
  } else throw invalid("repeat 要么是对象，要么是字符串");
  days = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (!days.length) return null;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (time && (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 59)) throw invalid(`时间要写成 10:00 这样：${time}`);
  return { days, time: time ? time.padStart(5, "0") : "" };
}

/** Checks in on a day, or takes the check-in back. Returns true if anything actually changed */
export function checkDate(item, date, done = true) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid(`日期要写成 2026-10-20：${date}`);
  const set = new Set(item.doneDates ?? []);
  const had = set.has(date);
  if (done) set.add(date); else set.delete(date);
  item.doneDates = [...set].sort().slice(-400);
  item.updatedAt = nowIso();
  return had !== done;
}

/** Recurring items are never "done": an item marked done goes back to todo, and the day it was done becomes a check-in */
export function doneToCheckIn(item) {
  if (item.doneAt) item.doneDates = [...new Set([...(item.doneDates ?? []), ymd(repeatDay(item.repeat, new Date(item.doneAt)))])].sort();
  item.status = "todo";
  delete item.doneAt;
}

/** Changes an item's status and fields. patch may hold status, title, note, due, group, repeat, agent (an object, merged in),
 *  waitingOn, reason and seen (true sets "last checked" to now).
 *  Given doc, handing the item off to an agent (or changing where it runs) also records the place. Returns { field: [old, new] } */
export function applyPatch(item, patch, doc) {
  const changes = {};
  const t = nowIso();
  const wasAgent = item.status === "agent", prevWhere = item.agent?.where ?? "";
  if (patch.title !== undefined && !String(patch.title).trim()) throw invalid("标题不能是空的");
  if (patch.due) patch = { ...patch, due: fixDueYear(String(patch.due).trim()) };
  for (const key of ["title", "note", "due", "reason", "waitingOn"]) {
    if (patch[key] === undefined) continue;
    if (CLEARABLE.includes(key) && (patch[key] === "" || patch[key] === null)) {
      if (item[key]) changes[key] = [item[key], null];
      delete item[key];
    } else if (patch[key] !== item[key]) {
      changes[key] = [item[key] ?? null, patch[key]];
      item[key] = patch[key];
    }
  }
  if (patch.group !== undefined) {
    if (!doc) throw new Error("挪分组要传 doc");
    const moved = moveToGroup(doc, item, patch.group);
    if (moved) changes.group = moved;
  }
  if (patch.repeat !== undefined) {
    const r = normalizeRepeat(patch.repeat);
    if (JSON.stringify(r) !== JSON.stringify(item.repeat ?? null)) {
      changes.repeat = [item.repeat ?? null, r];
      if (r) item.repeat = r; else delete item.repeat;
    }
    if (item.repeat && item.status === "done") { doneToCheckIn(item); changes.status = ["done", "todo"]; }
  }
  // Recurring items are never "done", only done for today: turn done into a check-in for today
  if (patch.status === "done" && item.repeat?.days?.length) {
    const today = repeatState(item).key;
    if (checkDate(item, today, true)) changes.check = [today, true];
    patch = { ...patch, status: undefined };
  }
  if (patch.status && patch.status !== item.status) {
    if (!ORDER.includes(patch.status)) throw invalid(`未知状态：${patch.status}`);
    changes.status = [item.status, patch.status];
    item.status = patch.status;
    if (patch.status === "agent") item.agent = { where: "", note: "", ...(item.agent ?? {}), since: t, lastSeen: t };
    if (patch.status === "done") item.doneAt = t;
    else delete item.doneAt;
  }
  if (patch.agent && typeof patch.agent === "object") {
    item.agent = { ...(item.agent ?? {}), ...patch.agent };
    changes.agent = patch.agent;
  }
  if (patch.seen && item.agent) {
    item.agent.lastSeen = t;
    changes.seen = true;
  }
  const where = item.agent?.where?.trim();
  if (doc && item.status === "agent" && where && (!wasAgent || where !== prevWhere.trim())) touchPlace(doc, where, t);
  item.updatedAt = t;
  return changes;
}

/** Moves the item to another card (id or part of its title), last in that card. Returns [old, new], or null if it did not move */
export function moveToGroup(doc, item, groupRef) {
  const g = findGroup(doc, groupRef);
  if (!g) throw invalid(`没有这个分组：${groupRef}`);
  if (g.id === item.group) return null;
  const from = item.group;
  item.group = g.id;
  item.order = nextOrder(itemsOf(doc, g.id).filter((x) => x !== item));
  return [from, g.id];
}

/** Remembers deleted items that came from Canvas sync, so they are never imported again (see canvas/merge.mjs) */
export function rememberDismissed(doc, items) {
  const keys = items.map((i) => (i?.source?.type === "canvas" ? i.source.key : null)).filter(Boolean);
  if (!keys.length) return;
  doc.extras ??= {};
  doc.extras.canvasDismissed = [...new Set([...(doc.extras.canvasDismissed ?? []), ...keys])].slice(-500);
}

// ---- Used by the board's API: each returns one log entry, or null when nothing changed ----

/** Adds an item: group is a card id or part of a card title, and the item goes last in that card. Status, due date, agent
 *  hand-off and the rest go through applyPatch */
export function addItem(doc, { group, title, note = "", status, due, agent, waitingOn, reason, repeat } = {}) {
  const g = findGroup(doc, group);
  if (!g) throw invalid(`没有这个分组：${group}`);
  if (!String(title ?? "").trim()) throw invalid("要有标题");
  const t = nowIso();
  const item = { id: newId(), group: g.id, title: String(title).trim(), status: "todo", note, order: nextOrder(itemsOf(doc, g.id)), createdAt: t, updatedAt: t };
  doc.items.push(item);
  applyPatch(item, { due, repeat, status: status && status !== "todo" ? status : undefined, agent, waitingOn, reason }, doc);
  return { op: "add", id: item.id, title: item.title, group: item.group, status: item.status };
}

export function updateItem(doc, id, patch) {
  const item = getItem(doc, id);
  const changes = applyPatch(item, patch, doc); // moving to another card happens here too (existing cards only)
  return Object.keys(changes).length ? { op: "update", id, title: item.title, changes } : null;
}

export function deleteItem(doc, id) {
  const item = getItem(doc, id);
  doc.items = doc.items.filter((i) => i !== item);
  rememberDismissed(doc, [item]);
  return { op: "delete", id, title: item.title };
}

/** Checks a recurring item in on a day, or takes the check-in back: { date: "2026-10-20", done: true }. Without a date, the
 *  day is the item's "today" (based on its refresh time) */
export function checkItem(doc, id, { date, done } = {}) {
  const item = getItem(doc, id);
  const day = date ?? repeatState(item)?.key ?? ymd(new Date()), on = done !== false;
  return checkDate(item, day, on) ? { op: "check", id, title: item.title, date: day, done: on } : null;
}

/** Moves up or down: { dir: "up" | "down" }. With within: "open" it moves only among open items (the board lists closed ones
 *  at the bottom, so it must not swap places with them) */
export function moveItem(doc, id, { dir, within } = {}) {
  const item = getItem(doc, id);
  const list = itemsOf(doc, item.group).filter((i) => within !== "open" || OPEN.includes(i.status) || i.id === id);
  return moveIn(list, id, dir) ? { op: "move", id, dir } : null;
}
