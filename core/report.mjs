// The two plain-text views: the Markdown copy (node data.mjs markdown prints it; handy for reading in a Markdown app such as
// Obsidian) and the briefing for agents (status in client.mjs)
import { LABEL, ICON, OPEN, sections, groupsOf, itemsOf } from "../web/lib/model.js";
import { repeatLabel, repeatState, agentActive } from "../web/lib/repeat.js";
import { placesByRecency } from "../web/lib/places.js";
import { ago as rel } from "../web/lib/time.js";

const minute = (iso) => iso.slice(0, 16).replace("T", " ");

export function toMarkdown(doc) {
  const out = [
    "# ToDo",
    "",
    "这份是从看板导出的（`node data.mjs markdown`），别直接改这里。",
    "",
    `更新于 ${doc.updatedAt}（rev ${doc.rev}）。`,
    "",
  ];
  const line = (i) => {
    let s = `- ${i.status === "done" ? "[x]" : "[ ]"} ${ICON[i.status]} ${i.title}（${LABEL[i.status]}）`;
    const extra = [];
    if (i.status === "agent" && i.agent) {
      extra.push(`挂在：${i.agent.where || "没写"}`);
      if (i.agent.since) extra.push(`挂上 ${minute(i.agent.since)}`);
      if (i.agent.lastSeen) extra.push(`上次看 ${minute(i.agent.lastSeen)}`);
      if (i.agent.note) extra.push(i.agent.note);
    }
    if (i.status === "waiting" && i.waitingOn) extra.push(`在等：${i.waitingOn}`);
    if (i.due) extra.push(`截止：${i.due}`);
    if (i.repeat?.days?.length) extra.push(`重复：${repeatLabel(i.repeat)}`);
    if (i.note) extra.push(i.note);
    if (i.status === "dropped" && i.reason) extra.push(`原因：${i.reason}`);
    if (extra.length) s += `。${extra.join("；")}`;
    return s;
  };
  for (const sec of sections(doc)) {
    if (sec.hidden) continue;
    const groups = groupsOf(doc, sec.id);
    const any = groups.some((g) => doc.items.some((i) => i.group === g.id && OPEN.includes(i.status)));
    if (!any && !sec.note) continue;
    out.push(`## ${sec.title}`, "");
    if (sec.note) out.push(sec.note, "");
    for (const g of groups) {
      const items = itemsOf(doc, g.id).filter((i) => OPEN.includes(i.status));
      if (!items.length && groups.length > 1 && !g.note) continue;
      if (groups.length > 1 || g.title !== sec.title) out.push(`### ${g.title}`, "");
      if (g.note) out.push(g.note, "");
      for (const i of items) out.push(line(i));
      if (items.length) out.push("");
    }
  }
  const closed = doc.items.filter((i) => !OPEN.includes(i.status));
  if (closed.length) {
    out.push("## 做完的和不做的", "");
    for (const i of closed.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) out.push(line(i));
    out.push("");
  }
  if (doc.extras?.yearGoals?.length) {
    out.push(`## ${doc.extras.yearGoalsTitle ?? "年度目标"}`, "");
    for (const g of doc.extras.yearGoals) out.push(`- ${g}`);
    out.push("");
  }
  return out.join("\n");
}

/** The briefing for agents: first the items handed off to agents, then doing, waiting and check-ins, and finally to do. */
export function summary(doc, { includeTodo = true } = {}) {
  const now = Date.now();
  const groupTitle = (id) => doc.groups.find((g) => g.id === id)?.title ?? id;
  const by = (s) => doc.items.filter((i) => i.status === s);
  const lines = [`${doc.theme?.title || "ToDo"}（rev ${doc.rev}，更新于 ${rel(doc.updatedAt, now)}）`];
  const agent = by("agent").filter((i) => agentActive(i)).sort((a, b) => (a.agent?.lastSeen ?? "").localeCompare(b.agent?.lastSeen ?? ""));
  const idle = by("agent").length - agent.length;
  lines.push("", `⚙ Agent 在做（${agent.length}${idle ? `；另有 ${idle} 件重复的事今天已经做完或者不用做，见下面的打卡` : ""}）`);
  const places = placesByRecency(doc).slice(0, 8).map((p) => p.name);
  if (places.length) lines.push(`常挂的地方（最近用过的在前，挂 Agent 时照这个写）：${places.join("、")}`);
  for (const i of agent) {
    const a = i.agent ?? {};
    lines.push(`- [${i.id}] ${i.title}｜${groupTitle(i.group)}｜挂在：${a.where || "没写"}｜挂了 ${rel(a.since, now)}｜上次看 ${rel(a.lastSeen, now)}${a.note ? `｜${a.note}` : ""}`);
  }
  for (const s of ["doing", "waiting"]) {
    const xs = by(s);
    lines.push("", `${ICON[s]} ${LABEL[s]}（${xs.length}）`);
    for (const i of xs) lines.push(`- [${i.id}] ${i.title}｜${groupTitle(i.group)}${i.waitingOn ? `｜在等：${i.waitingOn}` : ""}${i.due ? `｜截止：${i.due}` : ""}`);
  }
  const reps = doc.items.filter((i) => i.repeat?.days?.length && OPEN.includes(i.status));
  if (reps.length) {
    lines.push("", `↻ 打卡（${reps.length}）`);
    for (const i of reps) {
      const st = repeatState(i);
      const today = !st.scheduled ? "今天不用做" : st.done ? "今天做完了" : "今天还没做";
      lines.push(`- [${i.id}] ${i.title}｜${st.label}｜${today}${st.streak ? `｜连续 ${st.streak} ${st.unit}` : ""}`);
    }
  }
  const todo = by("todo");
  lines.push("", `○ 还没做（${todo.length}）`);
  if (includeTodo) for (const i of todo) lines.push(`- [${i.id}] ${i.title}｜${groupTitle(i.group)}${i.due ? `｜截止：${i.due}` : ""}`);
  lines.push("", `✓ 做完了 ${by("done").length} 条，✕ 不做了 ${by("dropped").length} 条。`);
  return lines.join("\n");
}
