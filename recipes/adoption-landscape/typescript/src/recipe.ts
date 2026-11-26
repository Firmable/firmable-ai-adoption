/**
 * AI adoption landscape: how far a cohort of companies you supply has adopted AI, and on what evidence.
 * Mirrors recipes/adoption-landscape/python/src/adoption_landscape/recipe.py; see that file and the
 * recipe README for the workflow and measurement rules.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConfigError, FirmableError, InvalidResponseError, Json, PlannedCall, Recipe, Report, RunContext, Row,
  badge, detailsJson, esc, kv, normaliseDomain, note, pricing, pyRepr, raw, readRows, table,
} from "firmable-api-client";

export const NAME = "adoption-landscape";
export const TITLE = "AI adoption landscape";
export const DESCRIPTION = "Shows how far a cohort of companies you supply has adopted AI: overall level, each area's level " +
  "and observability, and momentum, per group, from the Firmable AI Adoption API.";

export const DIMENSIONS = ["architecture", "footprint", "hiring", "initiatives", "workforce"];
// The order the API docs list these values in. It is used for display only and is not a ranking.
export const LEVEL_ORDER = ["NONE", "BASIC", "MEANINGFUL", "MODERATE", "STRONG", "ADVANCED"];
const OBSERVABILITY_ORDER = ["LOW", "MEDIUM", "HIGH"];
const RESPONSE_GROUPS = ["industry_group", "size_band", "country"];
const STATUSES = ["found", "not_found", "error", "not_processed", "invalid_input"];
const NOT_RETURNED = "(not returned)";
const BLANK = "(blank)";
const COHORT = "All companies";
const STATUS_TONE: Record<string, string> = {
  found: "good", not_found: "unknown", error: "error", not_processed: "unknown", invalid_input: "error",
};
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOP_KEYS = new Set(["batch_size", "with_evidence", "group_by", "min_answered"]);
const ENDPOINT = "POST /ai-adoption";
export const EXPLORER_JS_PATH = fileURLToPath(new URL("../../../assets/explorer.js", import.meta.url));

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x); // eslint-disable-line @typescript-eslint/no-explicit-any
const whole = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
const nn = (v: unknown): Json => (v === undefined ? null : v);
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

// ----- configuration --------------------------------------------------------------------------

export function loadConfig(raw: Record<string, unknown>): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const batchSize = raw.batch_size ?? 100;
  if (!whole(batchSize, 1) || batchSize > 100) throw new ConfigError("batch_size must be a whole number from 1 to 100.");
  const withEvidence = raw.with_evidence ?? false;
  if (typeof withEvidence !== "boolean") throw new ConfigError("with_evidence must be true or false.");
  const groupBy = raw.group_by ?? null;
  if (groupBy !== null && (typeof groupBy !== "string" || !groupBy.trim() || groupBy === "row_id")) {
    throw new ConfigError(`group_by must be null, an input column name, or one of: ${RESPONSE_GROUPS.join(", ")}.`);
  }
  const minAnswered = raw.min_answered ?? 5;
  if (!whole(minAnswered, 1)) throw new ConfigError("min_answered must be a whole number, 1 or more.");
  return { batch_size: batchSize, with_evidence: withEvidence, group_by: typeof groupBy === "string" ? groupBy.trim() : null,
    min_answered: minAnswered };
}

export function readInput(path: string): Row[] {
  return readRows(path, { anyOf: ["domain", "company_id"] });
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
  return [new PlannedCall(ENDPOINT, `AI Adoption for ${n} unique valid company(ies) in batches of up to ${b}` +
    (config.with_evidence ? ", with evidence" : ""), Math.ceil(n / b), pricing.estimateAiAdoption(n, config.with_evidence))];
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

/** Sends the subjects in batches and returns an outcome per subject key. See fetch_all in Python. */
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
    dimensions, evidence_available: isObj(comp.evidence_available) ? comp.evidence_available : null,
    as_of: nn(comp.as_of), framework_version: nn(comp.framework_version),
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

// ----- measures -------------------------------------------------------------------------------

export function pct(n: number, d: number): number | null {
  if (d === 0) return null;
  return Math.floor((n * 1000) / d + 0.5) / 10;
}

export function pctText(v: number | null): string {
  return v === null ? "-" : String(v);
}

export function distribution(values: unknown[], order: string[], notFound: number, minAnswered: number): Json {
  const answered = values.filter(isText);
  const counts: Record<string, number> = {};
  for (const v of answered) counts[v] = (counts[v] ?? 0) + 1;
  const keys = [...order.filter((k) => k in counts), ...Object.keys(counts).filter((k) => !order.includes(k)).sort()];
  const n = answered.length;
  const noValue = notFound + values.length - n;
  const tooFew = n < minAnswered;
  return {
    answered: n, no_value: noValue, no_value_share_pct: pct(noValue, values.length + notFound), too_few_answers: tooFew,
    values: keys.map((k) => ({ value: k, count: counts[k], share_pct: tooFew ? null : pct(counts[k], n) })),
  };
}

export function measureBlock(label: string, units: Json[], minAnswered: number): Json {
  const c: Record<string, number> = {};
  for (const s of STATUSES) c[s] = 0;
  for (const u of units) c[u.status] += 1;
  const found = units.filter((u) => u.status === "found").map((u) => u.ai_adoption);
  const nf = c.not_found;
  const dims: Json = {};
  for (const d of DIMENSIONS) {
    const areas = found.map((a) => a.dimensions[d] ?? {});
    dims[d] = {
      level: distribution(areas.map((x) => x.level), LEVEL_ORDER, nf, minAnswered),
      observability: distribution(areas.map((x) => x.observability), OBSERVABILITY_ORDER, nf, minAnswered),
    };
  }
  return {
    group: label, companies: units.length, asked: c.found + c.not_found + c.error, ...c,
    overall_level: distribution(found.map((a) => a.overall_level), LEVEL_ORDER, nf, minAnswered),
    momentum: distribution(found.map((a) => a.momentum_label), [], nf, minAnswered),
    dimensions: dims,
  };
}

function groupValue(row: Json, groupBy: string | null): string | null {
  if (groupBy === null) return null;
  if (RESPONSE_GROUPS.includes(groupBy)) {
    const v = (row.ai_adoption ?? {})[groupBy];
    return isText(v) ? v : NOT_RETURNED;
  }
  const v = row.input[groupBy] || "";
  return v ? v : BLANK;
}

function groupSort(labels: string[]): string[] {
  const special = [NOT_RETURNED, BLANK].filter((x) => labels.includes(x));
  return [...labels.filter((x) => !special.includes(x)).sort(), ...special];
}

function unitId(row: Json): string {
  const ai = row.ai_adoption ?? {};
  if (row.status === "found" && isText(ai.firmable_id)) return `firmable:${ai.firmable_id}`;
  return row.subject_key || `invalid:${row.row_id}`;
}

// ----- run ------------------------------------------------------------------------------------

function buildRows(ctx: RunContext, outcomes: Record<string, Json>, withEvidence: boolean): Json[] {
  const rows: Json[] = [];
  const firstByKey: Record<string, string> = {};
  const firstByFirmable: Record<string, [string, string]> = {};
  for (const r of ctx.rows) {
    const s = subjectOf(r);
    const base: Json = {
      row_id: r.row_id, input: r, subject_kind: s.kind, subject: s.value, subject_key: s.key, duplicate_of: null,
      same_company_as: null, group: null, ai_adoption: null, evidence_summary: null, api_message: null, error: null,
    };
    if (s.key === null) { rows.push({ ...base, status: "invalid_input", status_reason: s.reason }); continue; }
    if (s.key in firstByKey) base.duplicate_of = firstByKey[s.key];
    else firstByKey[s.key] = r.row_id;
    const o = outcomes[s.key] ?? { state: "not_processed", reason: "This company was not sent." };
    if (o.state === "found") {
      const ai = aiSummary(o.response.company);
      base.ai_adoption = ai;
      if (withEvidence) base.evidence_summary = evidenceSummary(o.response.evidence);
      const fid = ai.firmable_id;
      if (isText(fid)) {
        const prev = firstByFirmable[fid];
        if (prev !== undefined && prev[1] !== s.key) base.same_company_as = prev[0];
        else if (prev === undefined) firstByFirmable[fid] = [r.row_id, s.key];
      }
      const level = ai.overall_level;
      const reason = isText(level) ? `Found. Overall level ${level} as returned.` : "Found. No overall level was returned.";
      rows.push({ ...base, status: "found", status_reason: reason });
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

export function compute(rows: Json[], config: Json): Json {
  const groupBy: string | null = config.group_by;
  const minAnswered: number = config.min_answered;
  for (const r of rows) r.group = groupValue(r, groupBy);
  const cohortUnits = new Map<string, Json>();
  const groups = new Map<string, Map<string, Json>>();
  for (const r of rows) {
    const uid = unitId(r);
    if (!cohortUnits.has(uid)) cohortUnits.set(uid, r);
    if (groupBy !== null) {
      if (!groups.has(r.group)) groups.set(r.group, new Map());
      const g = groups.get(r.group)!;
      if (!g.has(uid)) g.set(uid, r);
    }
  }
  const cohort = measureBlock(COHORT, [...cohortUnits.values()], minAnswered);
  const blocks = groupSort([...groups.keys()]).map((g) => measureBlock(g, [...groups.get(g)!.values()], minAnswered));
  return { cohort, groups: blocks };
}

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const subjects = uniqueSubjects(ctx.rows);
  const outcomes = await fetchAll(ctx, subjects, cfg.batch_size, cfg.with_evidence);
  const rows = buildRows(ctx, outcomes, cfg.with_evidence);
  const measures = compute(rows, cfg);

  const coverage: string[] = [
    "The cohort is the list of companies you supplied. The REST API has no general company search, so these " +
      "measures describe this cohort only, not a market, sector or population.",
    "Each share is a count over the companies in the group with a value returned, and the denominator is shown " +
      "with it.",
    "Companies not found, and areas with no level returned, are counted as no value beside each share. They are " +
      "never counted as no adoption.",
    "Levels are shown as returned. The API docs list levels such as NONE, BASIC, MEANINGFUL, MODERATE, STRONG and " +
      "ADVANCED but define no ranking, so this recipe does not rank or score them.",
    `A measure with fewer than ${cfg.min_answered} answered companies is marked too few answers to compare, ` +
      "and no share is shown for it.",
    "An AI adoption level or a momentum label does not prove buying intent.",
    "AI Adoption explanations, headlines and momentum signals are shown as returned.",
  ];
  if (cfg.group_by !== null) {
    if (RESPONSE_GROUPS.includes(cfg.group_by)) {
      coverage.push(`Groups come from the ${cfg.group_by} field of each AI Adoption answer. Companies ` +
        `without an answer are in the group ${NOT_RETURNED}.`);
    } else if (!ctx.rows.some((r) => cfg.group_by in r)) {
      coverage.push(`The input file has no column ${cfg.group_by}, so every company is in the group ${BLANK}.`);
    } else {
      coverage.push(`Groups come from the input column ${cfg.group_by}. A company whose rows carry ` +
        "different values counts once in each of those groups.");
    }
  }
  if (cfg.with_evidence) {
    coverage.push("Evidence items with qualifies false are counted separately; they do not count towards a " +
      "level. Evidence is summarised as returned.");
    coverage.push("The response does not say which organisation each evidence item belongs to beyond its " +
      "ref, so evidence that belongs to a different organisation cannot be detected here.");
  }
  const dupes = rows.filter((r) => r.duplicate_of).length;
  if (dupes) {
    coverage.push(`${dupes} row(s) repeat an earlier company; its answer was reused, not requested again, and ` +
      "it is counted once.");
  }
  const same = rows.filter((r) => r.same_company_as).length;
  if (same) {
    coverage.push(`${same} row(s) resolve to the same Firmable company as an earlier row with a different ` +
      "identifier. They are counted once.");
  }
  const firsts = rows.filter((r) => !r.duplicate_of && !r.same_company_as);
  const nf = firsts.filter((r) => r.status === "not_found").length;
  if (nf) {
    coverage.push(`${nf} company(ies) have no AI Adoption data in Firmable (not found). This means no data was ` +
      "retrieved, not that the company has no AI adoption.");
  }
  const invalid = rows.filter((r) => r.status === "invalid_input").length;
  if (invalid) coverage.push(`${invalid} row(s) have no valid domain or company ID and were not sent.`);
  const foundAi: Json[] = firsts.filter((r) => r.status === "found").map((r) => r.ai_adoption);
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
  const low = foundAi.reduce((n, a) => n + DIMENSIONS.filter((d) => (a.dimensions[d] ?? {}).observability === "LOW").length, 0);
  if (low) {
    coverage.push(`${low} area result(s) have LOW observability: Firmable can see little of that area for the ` +
      "company. Read those levels with that in mind.");
  }
  const truncated = firsts.reduce((n, r) => n + Object.values(r.evidence_summary ?? {}).filter((e: Json) => e.truncated).length, 0);
  if (truncated) {
    coverage.push(`${truncated} evidence area(s) are truncated: the response holds fewer items than item_count.`);
  }

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const dates = foundAi.map((a) => a.as_of).filter(isText).sort();
  const summary = {
    status_counts: counts, group_by: cfg.group_by, min_answered: cfg.min_answered, cohort: measures.cohort,
    groups: measures.groups, unfamiliar_levels: unfamiliar, framework_versions: versions,
    as_of_earliest: dates.length ? dates[0] : null, as_of_latest: dates.length ? dates[dates.length - 1] : null,
  };
  return { rows, summary, coverage };
}

// ----- output ---------------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "domain", "company_id", "duplicate_of", "same_company_as", "group", "status",
  "status_reason", "firmable_id", "company_name", "country", "industry_group", "size_band", "overall_level", "momentum",
  ...DIMENSIONS.map((d) => `${d}_level`), ...DIMENSIONS.map((d) => `${d}_observability`), "as_of", "framework_version"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const ai = r.ai_adoption ?? {};
    const dims = ai.dimensions ?? {};
    const inp = r.input ?? {};
    const row: Record<string, unknown> = {
      row_id: r.row_id, domain: inp.domain, company_id: inp.company_id, duplicate_of: r.duplicate_of,
      same_company_as: r.same_company_as, group: r.group, status: r.status, status_reason: r.status_reason ?? r.reason,
      firmable_id: ai.firmable_id, company_name: ai.company_name, country: ai.country, industry_group: ai.industry_group,
      size_band: ai.size_band, overall_level: ai.overall_level, momentum: ai.momentum_label, as_of: ai.as_of,
      framework_version: ai.framework_version,
    };
    for (const d of DIMENSIONS) {
      row[`${d}_level`] = (dims[d] ?? {}).level;
      row[`${d}_observability`] = (dims[d] ?? {}).observability;
    }
    return row;
  });
}

export function explorerData(result: Json): Json {
  const s = result.summary;
  const companies = result.rows.filter((r: Json) => !r.duplicate_of).map((r: Json) => {
    const ai = r.ai_adoption ?? {};
    return {
      row_id: r.row_id, name: ai.company_name || r.subject || r.input.domain || r.input.company_id || r.row_id,
      subject: r.subject, group: r.group, status: r.status, status_reason: r.status_reason,
      same_company_as: r.same_company_as, ai: r.ai_adoption, evidence: r.evidence_summary,
    };
  });
  return { group_by: s.group_by, min_answered: s.min_answered, dimensions: DIMENSIONS, cohort: s.cohort,
    groups: s.groups ?? [], companies };
}

function distText(dist: Json): string {
  if (!dist.values.length) return "no value returned";
  if (dist.too_few_answers) {
    return dist.values.map((v: Json) => `${v.value} ${v.count}`).join("; ") + ` (of ${dist.answered}, too few answers to compare)`;
  }
  return dist.values.map((v: Json) => `${v.value} ${v.count} of ${dist.answered} (${pctText(v.share_pct)}%)`).join("; ");
}

function blockRow(b: Json): unknown[] {
  const d = b.overall_level;
  return [b.group, b.companies, b.asked, b.found, b.not_found, b.error, b.not_processed + b.invalid_input, distText(d),
    `${d.no_value} (${pctText(d.no_value_share_pct)}%)`];
}

const EXPLORER_CSS = "<style>.ex-controls{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 12px}" +
  ".ex-controls label{display:flex;flex-direction:column;font-size:13px;color:var(--muted);min-width:0}" +
  ".ex-controls select{font:inherit;padding:4px 6px;max-width:100%}" +
  ".ex-bar{display:grid;grid-template-columns:minmax(0,9em) minmax(0,1fr) minmax(0,9em);gap:8px;" +
  "align-items:center;margin:4px 0;font-size:14px}" +
  ".ex-track{background:var(--shale);border-radius:6px;height:12px;overflow:hidden}" +
  ".ex-fill{background:var(--ember);height:12px}" +
  ".ex-list button{font:inherit;background:none;border:0;color:var(--deep);text-decoration:underline;" +
  "cursor:pointer;padding:0;text-align:left}" +
  ".ex-panel{border:1px solid var(--shale);border-radius:12px;padding:12px 14px;margin:10px 0}" +
  "@media (max-width:480px){.ex-bar{grid-template-columns:minmax(0,1fr)}}</style>";

export function render(report: Report, result: Json): void {
  const s = result.summary;
  const cohort = s.cohort;
  if (!cohort) return;
  report.add("Result", "Cohort at a glance",
    "<p>" + Object.entries(s.status_counts ?? {}).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    kv([["Companies in the cohort", cohort.companies], ["Companies asked", cohort.asked], ["Found", cohort.found],
      ["Not found", cohort.not_found], ["Error", cohort.error], ["Not processed", cohort.not_processed],
      ["Invalid input", cohort.invalid_input],
      ["Data as of", `${s.as_of_earliest || "-"} to ${s.as_of_latest || "-"}`],
      ["Framework versions", (s.framework_versions ?? []).join(", ")]]) +
    note("These counts describe <strong>this cohort only</strong>, the companies you supplied. Not found is not no " +
      "adoption. Levels are shown as returned and are not ranked.", "unknown"));

  report.add("Explorer", "Explore the cohort", EXPLORER_CSS +
    '<div id="explorer"><p class="muted">The explorer needs JavaScript. The same figures are in the tables below.</p></div>');
  report.addData("explorer-data", explorerData(result));
  report.addScript(readFileSync(EXPLORER_JS_PATH, "utf-8"));

  const headers = ["Group", "Companies", "Asked", "Found", "Not found", "Error", "Not sent", "Overall level", "No value"];
  const groups: Json[] = s.groups ?? [];
  let body = table(headers, [blockRow(cohort), ...groups.map(blockRow)]);
  if (s.group_by) body = `<p>Grouped by <strong>${esc(s.group_by)}</strong>.</p>` + body;
  report.add("Levels", "Overall level by group", body + '<p class="muted">Each share is over the companies ' +
    "with a level returned. No value counts companies not found and companies with no level returned.</p>");

  const areaRows: unknown[][] = DIMENSIONS.map((d) => {
    const b = cohort.dimensions[d];
    return [d, distText(b.level), distText(b.observability), `${b.level.no_value} (${pctText(b.level.no_value_share_pct)}%)`];
  });
  areaRows.push(["momentum", distText(cohort.momentum), "-",
    `${cohort.momentum.no_value} (${pctText(cohort.momentum.no_value_share_pct)}%)`]);
  report.add("Areas", "Areas and momentum across the cohort", table(["Area", "Level", "Observability", "No value"], areaRows));

  const compRows = result.rows.map((r: Json) => {
    const ai = r.ai_adoption ?? {};
    const name = ai.company_name || r.subject || r.input.domain || r.input.company_id;
    const flags: string[] = [];
    if (r.duplicate_of) flags.push(`same input as ${r.duplicate_of}`);
    if (r.same_company_as) flags.push(`same Firmable company as ${r.same_company_as}`);
    return [r.row_id, name, raw(badge(r.status.replace(/_/g, " "), STATUS_TONE[r.status] ?? "neutral")), r.group,
      ai.overall_level, ai.momentum_label, ai.explanation, ai.as_of, flags.join("; ") || r.status_reason];
  });
  report.add("Companies", "Each company as returned",
    table(["Row", "Company", "Status", "Group", "Overall level", "Momentum", "Explanation", "As of", "Note"], compRows) +
    detailsJson("Measures as JSON", { cohort, groups }));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render,
};
