/**
 * Peer comparison: how one company's AI adoption compares with a peer cohort you define.
 * Mirrors recipes/peer-comparison/python/src/peer_comparison/recipe.py; see that file and the recipe
 * README for the workflow and comparison rules.
 */
import { basename } from "node:path";
import {
  ConfigError, FirmableError, InputError, InvalidResponseError, Json, PlannedCall, Recipe, Report, RunContext, Row,
  badge, bulletList, esc, kv, normaliseDomain, note, pricing, pyRepr, raw, readRows, table,
} from "firmable-api-client";

export const NAME = "peer-comparison";
export const TITLE = "AI adoption peer comparison";
export const DESCRIPTION = "Compares one company's AI adoption level, areas and momentum with a peer cohort you define, " +
  "using the Firmable AI Adoption API.";

export const DIMENSIONS = ["architecture", "footprint", "hiring", "initiatives", "workforce"];
// The order the API docs list levels in. It is used for display only and is not a ranking.
export const LEVEL_ORDER = ["NONE", "BASIC", "MEANINGFUL", "MODERATE", "STRONG", "ADVANCED"];
const STATUSES = ["found", "not_found", "error", "not_processed", "invalid_input"];
const BLANK = "(blank)";
const STATUS_TONE: Record<string, string> = {
  found: "good", not_found: "unknown", error: "error", not_processed: "unknown", invalid_input: "error", excluded: "neutral",
};
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOP_KEYS = new Set(["batch_size", "with_evidence", "min_answered"]);
const ENDPOINT = "POST /ai-adoption";
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const MEASURES: [string, string, string][] = [
  ["overall_level", "Overall level", "level"],
  ...DIMENSIONS.map((d): [string, string, string] => [d, `${capitalize(d)} level`, "level"]),
  ["momentum", "Momentum", "momentum label"],
];
export const INTERPRETATION = [
  "Values are shown as Firmable's AI Adoption API returned them.",
  "The API docs define no ranking of levels. This comparison says only whether a peer has the same value as the " +
    "focus company.",
  "Not found means Firmable holds no AI Adoption data for that company. It is not evidence of no adoption.",
  "The peers are the companies listed in the input. The comparison describes these peers only, not an industry, " +
    "market or population.",
  "An AI adoption level or a momentum label does not prove buying intent.",
];

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x); // eslint-disable-line @typescript-eslint/no-explicit-any
const whole = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
const nn = (v: unknown): Json => (v === undefined ? null : v);
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

// ----- configuration and input ----------------------------------------------------------------

export function loadConfig(raw: Record<string, unknown>): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const batchSize = raw.batch_size ?? 100;
  if (!whole(batchSize, 1) || batchSize > 100) throw new ConfigError("batch_size must be a whole number from 1 to 100.");
  const withEvidence = raw.with_evidence ?? false;
  if (typeof withEvidence !== "boolean") throw new ConfigError("with_evidence must be true or false.");
  const minAnswered = raw.min_answered ?? 5;
  if (!whole(minAnswered, 1)) throw new ConfigError("min_answered must be a whole number, 1 or more.");
  return { batch_size: batchSize, with_evidence: withEvidence, min_answered: minAnswered };
}

export function readInput(path: string): Row[] {
  const rows = readRows(path, { required: ["role"], anyOf: ["domain", "company_id"] });
  const problems: string[] = [];
  rows.forEach((r, i) => {
    const role = r.role.trim().toLowerCase();
    if (role !== "focus" && role !== "peer") problems.push(`row ${i + 1} (${r.row_id}): role must be focus or peer, not ${pyRepr(r.role)}`);
    r.role = role;
  });
  const focus = rows.filter((r) => r.role === "focus").length;
  if (focus !== 1) problems.push(`exactly one row must have role focus; found ${focus}`);
  if (problems.length) throw new InputError(`${basename(path)} has problems:\n  ` + problems.join("\n  "));
  return rows;
}

// ----- subjects and batching ------------------------------------------------------------------

export function subjectOf(row: Row): Json {
  const cid = (row.company_id ?? "").trim();
  if (cid) {
    if (COMPANY_ID.test(cid)) return { kind: "company_id", value: cid, key: `company_id:${cid}`, reason: null };
    return { kind: null, value: null, key: null, reason: `${pyRepr(cid)} is not a valid Firmable company ID.` };
  }
  const domain = normaliseDomain(row.domain);
  if (domain) return { kind: "domain", value: domain, key: `domain:${domain}`, reason: null };
  return { kind: null, value: null, key: null, reason: `${pyRepr(row.domain)} is not a valid domain.` };
}

export function uniqueSubjects(rows: Row[]): Json[] {
  const out: Json[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const s = subjectOf(r);
    if (s.key && !seen.has(s.key)) {
      seen.add(s.key);
      out.push({ ...s, row_id: r.row_id, external_id: r.row_id.slice(0, 200) });
    }
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = uniqueSubjects(rows).length;
  const b = config.batch_size;
  return [new PlannedCall(ENDPOINT, `AI Adoption for the focus company and peers: ${n} unique valid company(ies) in ` +
    `batches of up to ${b}` + (config.with_evidence ? ", with evidence" : ""), Math.ceil(n / b),
  pricing.estimateAiAdoption(n, config.with_evidence))];
}

function answerError(rowId: string, kind: string, code: unknown, message: string): Json {
  return { row_id: rowId, kind, status: 200, code: nn(code), endpoint: ENDPOINT, message, charge_uncertain: false, retry_after: null };
}

function classify(ctx: RunContext, s: Json, r: unknown, position: number): Json {
  if (!isObj(r)) {
    const entry = answerError(s.row_id, "invalid_response", null, `The answer in position ${position} is not a JSON object.`);
    ctx.errors.push(entry);
    return { state: "error", error: entry };
  }
  const inp = isObj(r.input) ? r.input : {};
  const echoed = nn(inp.external_id);
  if (echoed !== null && echoed !== s.external_id) {
    const entry = answerError(s.row_id, "invalid_response", null,
      `The answer in position ${position} carries external_id ${echoed}, but ${s.external_id} was sent there.`);
    ctx.errors.push(entry);
    return { state: "error", error: entry };
  }
  const err = isObj(r.error) ? r.error : null;
  if (isObj(r.company)) return { state: "found", response: r };
  if (err === null || err.code === "not_found") return { state: "not_found", response: r, message: nn((err ?? {}).message) };
  const entry = answerError(s.row_id, "answer_error", err.code, String(err.message || err.code || "error"));
  ctx.errors.push(entry);
  return { state: "error", error: entry };
}

export async function fetchAll(ctx: RunContext, subjects: Json[], batchSize: number, withEvidence: boolean): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (let start = 0; start < subjects.length; start += batchSize) {
    const batch = subjects.slice(start, start + batchSize);
    if (ctx.stopped !== null) {
      for (const s of batch) out[s.key] = { state: "not_processed", reason: `Run stopped earlier: ${ctx.stopped.message}` };
      continue;
    }
    const records = batch.map((s) => ({ [s.kind]: s.value, external_id: s.external_id }));
    let resp: Json;
    try {
      resp = await ctx.client.getAiAdoption({ records }, { withEvidence });
    } catch (e) {
      if (!(e instanceof FirmableError)) throw e;
      const entry = ctx.recordError(null, e);
      for (const s of batch) out[s.key] = { state: "error", error: entry };
      continue;
    }
    const results = resp.results;
    if (!Array.isArray(results) || results.length !== batch.length) {
      const count = Array.isArray(results) ? results.length : 0;
      ctx.client.budget.markUncertain();
      const entry = ctx.recordError(null, new InvalidResponseError(
        `The AI Adoption batch response has ${count} result(s) for ${batch.length} company(ies) sent.`,
        { status: 200, endpoint: ENDPOINT, chargeUncertain: true }));
      for (const s of batch) out[s.key] = { state: "error", error: entry };
      continue;
    }
    batch.forEach((s, i) => { out[s.key] = classify(ctx, s, results[i], i + 1); });
  }
  return out;
}

export function aiSummary(comp: Json): Json {
  const mom = isObj(comp.momentum) ? comp.momentum : {};
  const dims = isObj(comp.dimensions) ? comp.dimensions : {};
  const dimensions: Json = {};
  for (const d of DIMENSIONS) {
    dimensions[d] = isObj(dims[d]) ? {
      level: nn(dims[d].level), headline: nn(dims[d].headline), observability: nn(dims[d].observability),
      counts_toward_overall: nn(dims[d].counts_toward_overall),
    } : null;
  }
  return {
    firmable_id: nn(comp.firmable_id), company_name: nn(comp.company_name), country: nn(comp.country),
    industry_group: nn(comp.industry_group), size_band: nn(comp.size_band), overall_level: nn(comp.overall_level),
    explanation: nn(comp.explanation), momentum_label: nn(mom.label),
    momentum_signals: (Array.isArray(mom.signals) ? mom.signals : []).filter(isObj),
    dimensions, as_of: nn(comp.as_of), framework_version: nn(comp.framework_version),
  };
}

export function evidenceSummary(evidence: unknown): Json {
  const out: Json = {};
  if (!isObj(evidence)) return out;
  for (const area of DIMENSIONS) {
    const e = evidence[area];
    if (!isObj(e)) continue;
    const items = (Array.isArray(e.items) ? e.items : []).filter(isObj);
    out[area] = {
      item_count: nn(e.item_count), items_returned: items.length,
      qualifying: items.filter((i: Json) => i.qualifies === true).length,
      not_qualifying: items.filter((i: Json) => i.qualifies === false).length,
      truncated: e.truncated === true, as_of: nn(e.as_of),
    };
  }
  return out;
}

// ----- comparison -----------------------------------------------------------------------------

function measureValue(ai: Json, measure: string, facet = "level"): unknown {
  if (!ai) return null;
  if (measure === "overall_level") return ai.overall_level;
  if (measure === "momentum") return ai.momentum_label;
  return (ai.dimensions[measure] ?? {})[facet] ?? null;
}

export function compare(focus: Json, peers: Json[], minAnswered: number): Json[] {
  const found = peers.filter((p) => p.status === "found").map((p) => p.ai_adoption);
  const nf = peers.filter((p) => p.status === "not_found").length;
  const focusAi = focus.status === "found" ? focus.ai_adoption : null;
  return MEASURES.map(([measure, label, noun]) => {
    const values = found.map((a) => measureValue(a, measure));
    const answered = values.filter(isText);
    const counts: Record<string, number> = {};
    for (const v of answered) counts[v] = (counts[v] ?? 0) + 1;
    const order = measure === "momentum" ? [] : LEVEL_ORDER;
    const keys = [...order.filter((k) => k in counts), ...Object.keys(counts).filter((k) => !order.includes(k)).sort()];
    const n = answered.length;
    let fv: unknown = measureValue(focusAi, measure);
    const tooFew = n < minAnswered;
    let same: number | null = null;
    let placement: string;
    if (!isText(fv)) {
      fv = null;
      placement = "The focus company has no value for this measure, so it is not placed.";
    } else if (tooFew) {
      placement = `Too few answers to compare: ${n} peer(s) with a value, fewer than ${minAnswered}.`;
    } else {
      same = counts[fv] ?? 0;
      placement = `Same ${noun} as ${same} of ${n} peers with data.`;
    }
    return {
      measure, label, focus_value: fv,
      focus_observability: measure === "overall_level" || measure === "momentum" ? null : measureValue(focusAi, measure, "observability"),
      peers_with_value: n, peers_no_value: nf + values.length - n, too_few_answers: tooFew,
      distribution: keys.map((k) => ({ value: k, count: counts[k] })), same_as_focus: same, placement,
    };
  });
}

// ----- run ------------------------------------------------------------------------------------

function buildRows(ctx: RunContext, outcomes: Record<string, Json>, withEvidence: boolean): Json[] {
  const rows: Json[] = [];
  const firstByKey: Record<string, string> = {};
  const focusRow = ctx.rows.find((r) => r.role === "focus")!;
  const focusKey: string | null = subjectOf(focusRow).key;
  const focusOut = focusKey ? outcomes[focusKey] : undefined;
  let focusFid: unknown = null;
  if (focusOut && focusOut.state === "found") focusFid = nn(focusOut.response.company.firmable_id);
  for (const r of ctx.rows) {
    const s = subjectOf(r);
    const base: Json = {
      row_id: r.row_id, role: r.role, input: r, subject: s.value, subject_key: s.key, duplicate_of: null,
      ai_adoption: null, evidence_summary: null, api_message: null, error: null,
    };
    if (s.key === null) { rows.push({ ...base, status: "invalid_input", status_reason: s.reason }); continue; }
    if (s.key in firstByKey) base.duplicate_of = firstByKey[s.key];
    else firstByKey[s.key] = r.row_id;
    const o = outcomes[s.key] ?? { state: "not_processed", reason: "This company was not sent." };
    if (o.state === "found") {
      base.ai_adoption = aiSummary(o.response.company);
      if (withEvidence) base.evidence_summary = evidenceSummary(o.response.evidence);
    }
    if (r.role === "peer" && (s.key === focusKey || (focusFid && (base.ai_adoption ?? {}).firmable_id === focusFid))) {
      rows.push({ ...base, status: "excluded",
        status_reason: `Same company as the focus company (row ${focusRow.row_id}). Excluded from the peers.` });
      continue;
    }
    if (o.state === "found") {
      const level = base.ai_adoption.overall_level;
      rows.push({ ...base, status: "found",
        status_reason: isText(level) ? `Found. Overall level ${level} as returned.` : "Found. No overall level was returned." });
    } else if (o.state === "not_found") {
      base.api_message = nn(o.message);
      rows.push({ ...base, status: "not_found",
        status_reason: "Firmable has no AI Adoption data for this company (not found). This is not evidence of no adoption." });
    } else if (o.state === "error") {
      rows.push({ ...base, status: "error", error: o.error,
        status_reason: `No answer because of an error: ${String(o.error.message).replace(/\.+$/, "")}.` });
    } else {
      rows.push({ ...base, status: "not_processed", status_reason: o.reason });
    }
  }
  return rows;
}

function unitId(row: Json): string {
  const ai = row.ai_adoption ?? {};
  if (row.status === "found" && isText(ai.firmable_id)) return `firmable:${ai.firmable_id}`;
  return row.subject_key || `invalid:${row.row_id}`;
}

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const outcomes = await fetchAll(ctx, uniqueSubjects(ctx.rows), cfg.batch_size, cfg.with_evidence);
  const rows = buildRows(ctx, outcomes, cfg.with_evidence);
  const focus = rows.find((r) => r.role === "focus");
  const peerRows = rows.filter((r) => r.role === "peer");
  const units = new Map<string, Json>();
  for (const r of peerRows) {
    if (r.status !== "excluded" && !units.has(unitId(r))) units.set(unitId(r), r);
  }
  const peers = [...units.values()];
  const c: Record<string, number> = {};
  for (const s of STATUSES) c[s] = 0;
  for (const p of peers) c[p.status] += 1;
  let segments: Json[] = [];
  if (peerRows.some((r) => "segment" in r.input)) {
    const segCounts: Record<string, number> = {};
    for (const r of peerRows) {
      const label = r.input.segment || BLANK;
      segCounts[label] = (segCounts[label] ?? 0) + 1;
    }
    const labels = [...Object.keys(segCounts).filter((k) => k !== BLANK).sort(), ...(BLANK in segCounts ? [BLANK] : [])];
    segments = labels.map((k) => ({ segment: k, rows: segCounts[k] }));
  }
  const excluded = peerRows.filter((r) => r.status === "excluded");
  const cohort = {
    peer_rows: peerRows.length, companies: peers.length, asked: c.found + c.not_found + c.error, ...c,
    excluded_as_focus: excluded.length, segments,
  };
  const comparisons = compare(focus, peers, cfg.min_answered);
  const peersNotFound = peers.filter((p) => p.status === "not_found").map((p) => ({ row_id: p.row_id, subject: p.subject }));
  const peersWithoutAnswer = peers.filter((p) => ["error", "not_processed", "invalid_input"].includes(p.status))
    .map((p) => ({ row_id: p.row_id, subject: p.subject || p.input.domain || p.input.company_id || null, status: p.status,
      reason: p.status_reason }));

  const coverage: string[] = [
    "The peers are the companies you listed. The REST API has no general company search, so the comparison " +
      "describes these peers only. It does not represent an industry, market or population.",
    "Levels are shown as returned. The API docs define no ranking of levels, so this recipe reports only whether " +
      "a peer has the same value as the focus company, not whether it is higher or lower.",
    "Each placement states its denominator: the peers with a value returned for that measure.",
    "Peers not found, and areas with no level returned, are counted as no value. They are never counted as no " +
      "adoption.",
    `A measure with fewer than ${cfg.min_answered} peers with a value is marked too few answers to compare.`,
    "An AI adoption level or a momentum label does not prove buying intent.",
  ];
  if (focus.status !== "found") {
    coverage.push(`The focus company has no AI Adoption answer (status ${focus.status}), so no measure ` +
      "places it. The peer distribution is still shown.");
  }
  const dupes = rows.filter((r) => r.duplicate_of && r.status !== "excluded").length;
  if (dupes) coverage.push(`${dupes} row(s) repeat an earlier company; its answer was reused and it is counted once.`);
  const same = peerRows.filter((r) => r.status !== "excluded" && !r.duplicate_of).length - peers.length;
  if (same > 0) {
    coverage.push(`${same} peer row(s) resolve to the same Firmable company as an earlier peer. They are ` +
      "counted once.");
  }
  if (excluded.length) coverage.push(`${excluded.length} peer row(s) are the focus company and are excluded from the peers.`);
  if (peersNotFound.length) {
    coverage.push(`${peersNotFound.length} peer(s) have no AI Adoption data in Firmable (not found). This means ` +
      "no data was retrieved, not that the company has no AI adoption.");
  }
  let foundAi: Json[] = peers.filter((p) => p.status === "found").map((p) => p.ai_adoption);
  if (focus.status === "found") foundAi = [focus.ai_adoption, ...foundAi];
  const unfamiliar = [...new Set<string>(foundAi.flatMap((a) =>
    [a.overall_level, ...DIMENSIONS.map((d) => (a.dimensions[d] ?? {}).level)])
    .filter((v): v is string => isText(v) && !LEVEL_ORDER.includes(v)))].sort();
  if (unfamiliar.length) {
    coverage.push(`AI Adoption returned level(s) the docs do not list: ${unfamiliar.join(", ")}. They are kept ` +
      "as their own values.");
  }
  const versions = [...new Set<string>(foundAi.map((a) => a.framework_version).filter((v) => typeof v === "string"))].sort();
  if (versions.length > 1) {
    coverage.push(`Answers come from more than one framework version: ${versions.join(", ")}. Levels from ` +
      "different versions may not be comparable.");
  }
  if (cfg.with_evidence) {
    coverage.push("Evidence items with qualifies false are counted separately; they do not count towards a " +
      "level. The comparison uses levels only, not evidence.");
    const truncated = [focus, ...peers].reduce((n, r) => n + Object.values(r.evidence_summary ?? {}).filter((e: Json) => e.truncated).length, 0);
    if (truncated) {
      coverage.push(`${truncated} evidence area(s) are truncated: the response holds fewer items than item_count.`);
    }
  }

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const focusLevel = focus.status === "found" ? focus.ai_adoption.overall_level : null;
  for (const r of rows) {
    const lvl = (r.ai_adoption ?? {}).overall_level;
    r.same_overall_level_as_focus = null;
    if (r.role === "peer" && r.status === "found" && isText(focusLevel) && isText(lvl)) {
      r.same_overall_level_as_focus = lvl === focusLevel ? "yes" : "no";
    }
  }
  const summary = {
    status_counts: counts, min_answered: cfg.min_answered,
    focus: { row_id: focus.row_id, status: focus.status, status_reason: focus.status_reason, subject: focus.subject,
      ai_adoption: focus.ai_adoption, evidence_summary: focus.evidence_summary },
    peer_cohort: cohort, comparisons, peers_not_found: peersNotFound, peers_without_answer: peersWithoutAnswer,
    excluded_peers: excluded.map((r) => ({ row_id: r.row_id, subject: r.subject })),
  };
  return { rows, summary, coverage };
}

// ----- output ---------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "role", "domain", "company_id", "segment", "duplicate_of", "status", "status_reason",
  "firmable_id", "company_name", "overall_level", "same_overall_level_as_focus", "momentum",
  ...DIMENSIONS.map((d) => `${d}_level`), "as_of", "framework_version"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const ai = r.ai_adoption ?? {};
    const dims = ai.dimensions ?? {};
    const inp = r.input ?? {};
    const row: Record<string, unknown> = {
      row_id: r.row_id, role: inp.role, domain: inp.domain, company_id: inp.company_id, segment: inp.segment,
      duplicate_of: r.duplicate_of, status: r.status, status_reason: r.status_reason ?? r.reason,
      firmable_id: ai.firmable_id, company_name: ai.company_name, overall_level: ai.overall_level,
      same_overall_level_as_focus: r.same_overall_level_as_focus, momentum: ai.momentum_label, as_of: ai.as_of,
      framework_version: ai.framework_version,
    };
    for (const d of DIMENSIONS) row[`${d}_level`] = (dims[d] ?? {}).level;
    return row;
  });
}

/** Escapes Markdown special characters in API or input text. Empty values read "not returned". */
export function md(value: unknown): string {
  if (value === null || value === undefined || value === "") return "not returned";
  const s = String(value).replace(/\r/g, " ").replace(/\n/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
  return s.startsWith("#") ? "\\" + s : s;
}

function distMd(c: Json): string {
  if (!c.distribution.length) return "none";
  return c.distribution.map((d: Json) => `${md(d.value)} ${d.count} of ${c.peers_with_value}`).join("; ");
}

export function markdown(result: Json): Record<string, string> {
  const s = result.summary;
  if (!s.focus) return {};
  const f = s.focus;
  const ai = f.ai_adoption ?? {};
  const pc = s.peer_cohort;
  const name = ai.company_name || f.subject || f.row_id;
  const lines: string[] = ["# AI adoption peer comparison", "",
    `Focus company: ${md(name)} (row ${md(f.row_id)}).`, "",
    "Source: Firmable AI Adoption API. Values are shown as returned.", "",
    "## Peer cohort", "",
    `- Peer rows in the input: ${pc.peer_rows}`,
    `- Unique peer companies compared: ${pc.companies}`,
    `- Asked: ${pc.asked}. Found: ${pc.found}. Not found: ${pc.not_found}. Error: ${pc.error}. ` +
      `Not sent: ${pc.not_processed + pc.invalid_input}. Excluded as the focus company: ${pc.excluded_as_focus}.`];
  if (pc.segments.length) lines.push("- Segments in the input: " + pc.segments.map((x: Json) => `${md(x.segment)} (${x.rows})`).join(", "));
  lines.push("- The peers are the companies listed in the input. They do not represent an industry, market or population.",
    "", "## Focus company", "", "| Field | Value |", "| --- | --- |",
    `| Status | ${md(f.status)} |`, `| Overall level | ${md(ai.overall_level)} |`,
    `| Explanation | ${md(ai.explanation)} |`, `| Momentum | ${md(ai.momentum_label)} |`);
  const signals = (ai.momentum_signals ?? []).map((x: Json) => `${md(x.kind)}: ${md(x.count)}, latest ${md(x.latest)}`).join("; ");
  lines.push(`| Momentum signals | ${signals || "none returned"} |`, `| Data as of | ${md(ai.as_of)} |`,
    `| Framework version | ${md(ai.framework_version)} |`, "", "## Comparison", "",
    "| Measure | Focus | Focus observability | Peers with a value | Peer counts | Peers with no value | Placement |",
    "| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of s.comparisons) {
    const obs = c.measure === "overall_level" || c.measure === "momentum" ? "-" : md(c.focus_observability);
    lines.push(`| ${md(c.label)} | ${md(c.focus_value)} | ${obs} | ${c.peers_with_value} | ${distMd(c)} | ` +
      `${c.peers_no_value} | ${md(c.placement)} |`);
  }
  lines.push("", "## Peers not found", "");
  if (s.peers_not_found.length) {
    lines.push(...s.peers_not_found.map((p: Json) => `- Row ${md(p.row_id)}: ${md(p.subject)}`));
    lines.push("", "Not found means Firmable holds no AI Adoption data for the company. It is not evidence of no adoption.");
  } else {
    lines.push("None.");
  }
  lines.push("", "## Peers without an answer", "");
  if (s.peers_without_answer.length) {
    lines.push(...s.peers_without_answer.map((p: Json) => `- Row ${md(p.row_id)}: ${md(p.subject)}. ${md(p.status)}: ${md(p.reason)}`));
  } else {
    lines.push("None.");
  }
  if (s.excluded_peers.length) {
    lines.push("", "## Peers excluded as the focus company", "");
    lines.push(...s.excluded_peers.map((p: Json) => `- Row ${md(p.row_id)}: ${md(p.subject)}`));
  }
  lines.push("", "## Interpretation", "", ...INTERPRETATION.map((t) => `- ${t}`), "");
  return { "peer-comparison.md": lines.join("\n") };
}

export function render(report: Report, result: Json): void {
  const s = result.summary;
  const f = s.focus;
  if (!f) return;
  const ai = f.ai_adoption ?? {};
  const pc = s.peer_cohort;
  let left = kv([["Row", f.row_id], ["Status", f.status], ["Firmable ID", ai.firmable_id], ["Overall level", ai.overall_level],
    ["Explanation", ai.explanation], ["Momentum", ai.momentum_label], ["Data as of", ai.as_of],
    ["Framework version", ai.framework_version]]);
  if (f.status !== "found") left += note(esc(f.status_reason), "unknown");
  let right = "";
  if (f.ai_adoption) {
    right = table(["Area", "Level", "Observability", "Counts toward overall", "Headline"],
      DIMENSIONS.map((d) => {
        const x = ai.dimensions[d] ?? {};
        return [d, x.level, x.observability, x.counts_toward_overall, x.headline];
      }));
    if ((ai.momentum_signals ?? []).length) {
      right += table(["Momentum signal", "Count", "Latest"], ai.momentum_signals.map((x: Json) => [x.kind, x.count, x.latest]));
    }
  }
  report.add("Focus", `Focus company: ${ai.company_name || f.subject || f.row_id}`,
    `<div class="cols"><div>${left}</div><div>${right}</div></div>`);

  const rows = s.comparisons.map((c: Json) => {
    const dist = c.distribution.map((d: Json) => `${d.value} ${d.count} of ${c.peers_with_value}`).join("; ") || "none";
    return [c.label, c.focus_value, c.focus_observability, c.peers_with_value, dist, c.peers_no_value,
      raw(esc(c.placement) + (c.too_few_answers ? " " + badge("too few", "review") : ""))];
  });
  report.add("Comparison", "Focus company beside the peers",
    table(["Measure", "Focus", "Focus observability", "Peers with a value", "Peer counts", "Peers with no value", "Placement"], rows) +
    note("Levels are not ranked: the docs define no order. A placement says only how many peers have the same value. " +
      "These peers are the companies you listed and do not represent an industry.", "unknown"));

  const segs = pc.segments.map((x: Json) => `${x.segment} (${x.rows})`).join(", ") || null;
  report.add("Peers", "Peer cohort",
    kv([["Peer rows", pc.peer_rows], ["Unique peer companies", pc.companies], ["Asked", pc.asked], ["Found", pc.found],
      ["Not found", pc.not_found], ["Error", pc.error], ["Not sent", pc.not_processed + pc.invalid_input],
      ["Excluded as the focus company", pc.excluded_as_focus], ["Segments", segs]]) +
    table(["Row", "Role", "Company", "Status", "Overall level", "Same as focus", "Reason"],
      result.rows.map((r: Json) => [r.row_id, r.role,
        (r.ai_adoption ?? {}).company_name || r.subject || r.input.domain || r.input.company_id,
        raw(badge(r.status.replace(/_/g, " "), STATUS_TONE[r.status] ?? "neutral")),
        (r.ai_adoption ?? {}).overall_level, r.same_overall_level_as_focus, r.status_reason ?? r.reason])));
  report.add("Interpretation", "How to read this comparison", bulletList(INTERPRETATION));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render, markdown,
};
