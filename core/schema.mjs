// The shape of the board's document: default appearance and settings, an empty document, and filling in missing fields on load
// (normalize).
// Everything the board's settings can change lives in theme / settings; to add a setting, add a default here (the API accepts
// only the fields listed here).
import { nowIso } from "./doc.mjs";

export const DEFAULT_THEME = {
  mode: "auto",            // auto = follow the system / light / dark
  font: "default",         // default = Adventor Todo (web/fonts/), system = the system font, or any font name
  fontSize: 15,
  width: 1040,
  radius: 12,
  density: "comfortable",  // comfortable / compact
  layout: "sidebar",       // sidebar = title on the left, cards on the right / stacked = title on top
  showStats: true,
  title: "ToDo",
  accent: "",              // empty = black and white; or any color, e.g. hsl(200 29% 45%)
  customCss: "",
  showCalendar: true,      // calendar block
  showRepeat: true,        // check-in block (recurring items)
  hero: true,              // header animation
  heroStyle: "landscape",      // which header animation; the list is in web/lib/heroes/index.js
  heroHeight: 220,
  agentCols: 1,            // columns in the agent block: 1 / 2 / 3
  showToc: true,           // table of contents on the left (only when the margins are wide enough)
  closedMode: "recent",    // closed items: none = hidden / recent = only the last few days stay in cards / all (see web/lib/done.js)
  recentDays: 3,           // with closedMode recent, how many days of done items stay in cards: 1 / 3 / 7
  showDone: true,          // the "recently done" block
  doneChart: "bars",       // chart above "recently done": bars = two weeks of bars / heatmap (list in web/components/done/index.js)
  agentFx: "shatter",      // completion effect for agent cards, and (checkFx) for check-ins: none / random / one from the list (web/lib/fx/index.js)
  checkFx: "confetti",
};
// canvasGroup: the card (group id) that synced Canvas assignments go to; when empty, the first sync picks or creates a courses card
// (see canvas/merge.mjs)
export const DEFAULT_SETTINGS = { staleHours: 3, canvasGroup: "" };

export function emptyDoc() {
  return { version: 2, rev: 0, updatedAt: nowIso(), sections: [], groups: [], items: [], places: [], extras: {}, theme: { ...DEFAULT_THEME }, settings: { ...DEFAULT_SETTINGS } };
}

/** Fills in missing fields (rev, order, theme, settings, places), drops unnamed and duplicate places, and sorts. It also writes
 *  the few things the database stores only one way in that one way (an empty agent or list of check-ins is left out, a place
 *  always has lastUsed and uses), so a document is the same however it was stored */
export function normalize(doc) {
  doc.version = 2;
  doc.rev ??= 0;
  doc.updatedAt ??= nowIso();
  doc.sections ??= [];
  doc.groups ??= [];
  doc.items ??= [];
  doc.extras ??= {};
  doc.theme = { ...DEFAULT_THEME, ...(doc.theme ?? {}) };
  doc.places ??= [];
  doc.places = doc.places.filter((p, k, all) => p?.name?.trim() && all.findIndex((q) => q.name === p.name) === k);
  for (const p of doc.places) { p.lastUsed ??= null; p.uses ??= 0; }
  doc.settings = { ...DEFAULT_SETTINGS, ...(doc.settings ?? {}) };
  doc.sections.forEach((s, i) => { s.order ??= (i + 1) * 10; s.sub ??= ""; s.hidden ??= false; });
  const perSection = {};
  const sectionTitle = Object.fromEntries(doc.sections.map((s) => [s.id, s.title]));
  for (const g of doc.groups) {
    // The card a new section came with has been renamed (its title differs from the section's): it is a card of its own now and
    // shows its title
    if (g.plain && g.title !== sectionTitle[g.section]) delete g.plain;
    perSection[g.section] = (perSection[g.section] ?? 0) + 1;
    g.order ??= perSection[g.section] * 10;
  }
  const perGroup = {};
  for (const it of doc.items) {
    perGroup[it.group] = (perGroup[it.group] ?? 0) + 1;
    it.order ??= perGroup[it.group] * 10;
    if (it.agent && !Object.keys(it.agent).length) delete it.agent;
    if (it.doneDates && !it.doneDates.length) delete it.doneDates;
  }
  doc.sections.sort((a, b) => a.order - b.order);
  const sectionRank = Object.fromEntries(doc.sections.map((sec, k) => [sec.id, k]));
  doc.groups.sort((a, b) => (sectionRank[a.section] ?? 1e9) - (sectionRank[b.section] ?? 1e9) || a.order - b.order);
  return doc;
}
