// Canvas HTTP reader shared by Node and Cloudflare; no subprocesses or process-wide network settings.
const TIMEOUT_MS = 120_000;
const ASSIGN_FIELDS = ["id", "name", "due_at", "lock_at", "unlock_at", "html_url", "submission_types", "published"];

// ---- Reading the API directly ----

export async function fetchCanvasDirect(token, { timeoutMs = TIMEOUT_MS } = {}) {
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS); // a process-wide setting; Canvas is the only outbound connection the board server makes
  const signal = AbortSignal.timeout(timeoutMs);
  const rows = (await pages(host, "/api/v1/courses?enrollment_type=student&enrollment_state=active&per_page=100", token, signal)).filter((r) => r?.name);
  const courses = await Promise.all(rows.map(async (r) => {
    const base = { id: r.id, name: r.name || "" };
    try {
      const xs = await pages(host, `/api/v1/courses/${r.id}/assignments?include[]=submission&order_by=due_at&per_page=100`, token, signal);
      return { ...base, ok: true, assignments: xs.map(pickAssignment) };
    } catch (e) {
      return { ...base, ok: false, error: e?.message || "Canvas 出错" };
    }
  }));
  return check({ ok: true, host, fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"), courses });
}

// Follow the pages one by one (rel="next" in the Link header); pagination links must stay on CANVAS_HOST
async function pages(host, path, token, signal) {
  let url = `https://${host}${path}`;
  const out = [];
  while (url) {
    if (new URL(url).hostname !== host) throw new Error("分页链接指向了别的网站");
    let res;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal });
    } catch (e) {
      if (e?.name === "TimeoutError") throw new Error("Canvas 没响应（超时）");
      // include the underlying error code (ETIMEDOUT, ENOTFOUND, ...) so the board shows at a glance which kind of connection
      // failure it is
      const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code;
      throw new Error(`连不上 Canvas${code ? `（${code}）` : ""}`);
    }
    if (!res.ok) {
      const msg = { 401: "token 失效或被撤销（401）", 403: "没有权限（403）", 404: "找不到（404）" }[res.status];
      throw new Error(msg ?? `Canvas 出错（${res.status}）`);
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("Canvas 返回了看不懂的结果");
    out.push(...rows);
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

function nextLink(header) {
  for (const part of String(header ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

function pickAssignment(a) {
  const sub = a.submission ?? {};
  return {
    ...Object.fromEntries(ASSIGN_FIELDS.map((k) => [k, a[k] ?? null])),
    workflow_state: sub.workflow_state ?? null,
    submitted_at: sub.submitted_at ?? null,
    missing: Boolean(sub.missing),
    late: Boolean(sub.late),
    excused: Boolean(sub.excused),
  };
}

/** Rejects the whole export if its format is wrong */
export function check(d) {
  const bad = () => { throw new Error("Canvas 导出的格式不对"); };
  if (d?.ok !== true || typeof d.host !== "string" || !Array.isArray(d.courses)) bad();
  for (const c of d.courses) {
    if (!Number.isInteger(c.id) || typeof c.name !== "string" || typeof c.ok !== "boolean") bad();
    if (!c.ok) continue;
    if (!Array.isArray(c.assignments)) bad();
    for (const a of c.assignments) if (!Number.isInteger(a.id) || typeof a.name !== "string") bad();
  }
  return d;
}
