/**
 * Company AI brief: what AI adoption evidence Firmable holds for each company, as a Markdown brief.
 * Mirrors recipes/company-ai-brief/python/src/company_ai_brief/recipe.py; see that file and the
 * recipe README for the evidence rules. This code computes no score, no trend and no narrative.
 */
import { basename } from "node:path";
import {
  ConfigError, ErrorDict, FirmableError, InputError, InvalidResponseError, Json, PlannedCall, Recipe, Report,
  RunContext, Row, badge, bulletList, card, detailsJson, esc, kv, normaliseDomain, note, pricing, raw, readRows,
  table,
} from "firmable-api-client";

export const NAME = "company-ai-brief";
export const TITLE = "Company AI brief";
export const DESCRIPTION = "Builds a factual Markdown brief of the AI adoption evidence Firmable holds for each company: " +
  "levels, explanation, momentum and evidence as returned, with qualifying and non-qualifying " +
  "evidence kept apart and gaps stated.";

const AREAS = ["architecture", "footprint", "hiring", "initiatives", "workforce"];
const KNOWN_LEVELS = ["NONE", "BASIC", "MEANINGFUL", "MODERATE", "STRONG", "ADVANCED"];
const BASE_AREA_KEYS = new Set(["level", "headline", "observability", "counts_toward_overall"]);
const ORG_ID_FIELDS = ["company_id", "firmable_id", "organisation_id"];
const ORG_NAME_FIELDS = ["company_name", "employer", "organisation", "company"];
const TOP_KEYS = new Set(["with_evidence", "max_items_per_area", "batch_size"]);
const MAX_ROWS = 25;
const STATUS_TONE: Record<string, string> = {
  brief_ready: "good", not_found: "unknown", invalid_input: "error", error: "error", not_processed: "unknown",
};
const COMPANY_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const MD_SPECIAL = new Set(["\\", "`", "*", "_", "[", "]", "<", ">", "|"]);
const SAFE_NAME = /[^A-Za-z0-9_-]/g;

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number";

// ----- configuration and input -----------------------------------------------------------------

function whole(raw: Json, key: string, def: number, lo: number, hi: number): number {
  const v = raw[key] ?? def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new ConfigError(`${key} must be a whole number from ${lo} to ${hi}.`);
  }
  return v;
}

export function loadConfig(raw: Json): Json {
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const withEvidence = raw.with_evidence ?? true;
  if (typeof withEvidence !== "boolean") throw new ConfigError("with_evidence must be true or false.");
  return {
    with_evidence: withEvidence,
    max_items_per_area: whole(raw, "max_items_per_area", 5, 0, 100),
    batch_size: whole(raw, "batch_size", 100, 1, 100),
  };
}

export function readInput(path: string): Row[] {
  const rows = readRows(path, { anyOf: ["domain", "company_id"] });
  if (rows.length > MAX_ROWS) {
    throw new InputError(`${basename(path)} has ${rows.length} rows. This recipe takes 1 to ${MAX_ROWS} companies.`);
  }
  return rows;
}

export function subjectOf(row: Row): [Record<string, string> | null, string | null] {
  const cid = (row.company_id ?? "").trim();
  if (cid) {
    if (!COMPANY_ID.test(cid)) return [null, `The company_id "${cid}" is not a valid Firmable company ID.`];
    return [{ type: "company_id", value: cid }, null];
  }
  const rawDomain = row.domain ?? "";
  const d = normaliseDomain(rawDomain);
  if (!d) return [null, `The domain "${rawDomain}" is not a valid domain.`];
  return [{ type: "domain", value: d }, null];
}

const keyOf = (s: Record<string, string>): string => `${s.type}:${s.value}`;

function uniqueSubjects(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const [s] = subjectOf(r);
    if (s && !out.includes(keyOf(s))) out.push(keyOf(s));
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = uniqueSubjects(rows).length;
  const size: number = config.batch_size;
  const requests = Math.ceil(n / size);
  const what = config.with_evidence ? "AI Adoption with evidence" : "AI Adoption";
  return [new PlannedCall("POST /ai-adoption", `${what} for each unique valid company, in batches of up to ${size}`,
    requests, pricing.estimateAiAdoption(n, config.with_evidence))];
}

// ----- batched AI Adoption ---------------------------------------------------------------------

function rowError(code: unknown, message: unknown): ErrorDict {
  return {
    kind: "row_error" as ErrorDict["kind"], status: 200, code: (code ?? null) as string | null, endpoint: "POST /ai-adoption",
    message: `AI Adoption returned an error for this company: ${s(code) || "no code"}: ${s(message) || "no message"}`,
    charge_uncertain: false, retry_after: null,
  };
}

interface Batch { keys: string[]; status: string; error: Json }

export class BatchFetcher {
  batches: Batch[] = [];
  batchOf = new Map<string, number>();
  answers = new Map<string, [string, Json]>();

  constructor(readonly ctx: RunContext, keys: string[], readonly subjects: Map<string, Record<string, string>>,
    readonly externalIds: Map<string, string>, batchSize: number, readonly withEvidence: boolean) {
    for (let i = 0; i < keys.length; i += batchSize) this.batches.push({ keys: keys.slice(i, i + batchSize), status: "pending", error: null });
    keys.forEach((k, i) => this.batchOf.set(k, Math.floor(i / batchSize)));
  }

  /** Returns ["answer", answer], ["error", error entry] or ["mismatch", error entry]. */
  async get(key: string, rowId: string): Promise<[string, Json]> {
    const b = this.batches[this.batchOf.get(key)!];
    if (b.status === "pending") await this.send(b, rowId);
    if (b.status === "failed") return ["error", b.error];
    return this.answers.get(key)!;
  }

  private async send(b: Batch, rowId: string): Promise<void> {
    const records = b.keys.map((k) => {
      const subj = this.subjects.get(k)!;
      return { [subj.type]: subj.value, external_id: this.externalIds.get(k)! };
    });
    let results: Json[];
    try {
      const resp = await this.ctx.client.getAiAdoption({ records }, { withEvidence: this.withEvidence });
      const res = resp.results;
      if (!Array.isArray(res) || res.length !== records.length) {
        const got = Array.isArray(res) ? res.length : 0;
        this.ctx.client.budget.markUncertain();
        throw new InvalidResponseError(
          `The AI Adoption batch answer has ${got} result(s) for ${records.length} record(s) sent.`,
          { status: 200, endpoint: "POST /ai-adoption", chargeUncertain: true });
      }
      results = res;
    } catch (e) {
      if (!(e instanceof FirmableError)) throw e;
      b.status = "failed";
      b.error = this.ctx.recordError(rowId, e);
      return;
    }
    b.status = "done";
    b.keys.forEach((k, i) => {
      const ans = results[i];
      const echoed = isObj(ans.input) ? ans.input.external_id : undefined;
      const sent = records[i].external_id;
      if (echoed !== undefined && echoed !== null && echoed !== sent) {
        this.answers.set(k, ["mismatch", {
          kind: "row_error", status: 200, code: "external_id_mismatch", endpoint: "POST /ai-adoption",
          message: `The batch answer in this position carries external_id "${s(echoed)}", not "${sent}", so it was not used.`,
          charge_uncertain: false, retry_after: null,
        }]);
      } else {
        this.answers.set(k, ["answer", ans]);
      }
    });
  }
}

export function classify(ans: Json): string {
  if (isObj(ans.company)) return "found";
  const err = isObj(ans.error) ? ans.error : {};
  if (err.code === undefined || err.code === null || err.code === "not_found") return "not_found";
  return "row_error";
}

// ----- brief content ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Formats an API value as text the same way as the Python version. */
export function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function otherOrg(item: Json, companyId: unknown, names: string[]): Json[] {
  const found: Json[] = [];
  for (const field of ORG_ID_FIELDS) {
    const v = text(item[field]);
    if (v && v !== companyId) found.push({ field, value: v });
  }
  for (const field of ORG_NAME_FIELDS) {
    const v = text(item[field]);
    if (v && !names.includes(v.toLowerCase())) found.push({ field, value: v });
  }
  return found;
}

function area(name: string, dimRaw: unknown, available: unknown, evAll: unknown, cfg: Json, companyId: unknown, names: string[]): Json {
  const dim = isObj(dimRaw) ? dimRaw : null;
  const level = dim ? dim.level ?? null : null;
  const detail: Json = {};
  if (dim) for (const [k, v] of Object.entries(dim)) if (!BASE_AREA_KEYS.has(k)) detail[k] = v;
  const out: Json = {
    area: name, level,
    level_documented: typeof level === "string" ? KNOWN_LEVELS.includes(level) : null,
    headline: dim ? dim.headline ?? null : null,
    observability: dim ? dim.observability ?? null : null,
    counts_toward_overall: dim ? dim.counts_toward_overall ?? null : null,
    evidence_available: available ?? null,
    detail, flags: [], notes: [],
  };
  if (dim === null) out.flags.push("The API returned no data for this area.");
  else if (typeof level === "string" && !KNOWN_LEVELS.includes(level)) {
    out.notes.push(`The level ${level} is not one of the documented levels. It is shown as returned.`);
  }
  if (!cfg.with_evidence) {
    out.evidence = { status: "not_requested" };
    return out;
  }
  const ev = isObj(evAll) ? evAll[name] : undefined;
  if (!isObj(ev)) {
    out.evidence = { status: "not_returned" };
    if (isNum(available) && available > 0) {
      out.flags.push(`Firmable holds ${s(available)} evidence item(s) for this area, but none were returned.`);
    } else {
      out.notes.push("Not observed: no evidence was returned for this area. This does not mean the " +
        "company has no AI activity in this area.");
    }
    return out;
  }
  const items: Json[] = (Array.isArray(ev.items) ? ev.items : []).filter((i: unknown) => isObj(i));
  const limit: number = cfg.max_items_per_area;
  const shown = items.slice(0, limit);
  const count = ev.item_count ?? null;
  const truncated = ev.truncated === true;
  if (truncated) {
    const countText = isNum(count) ? s(count) : "an unknown number of";
    out.flags.push(`Evidence is truncated: ${items.length} of ${countText} item(s) were returned.`);
  }
  if (items.length > limit) {
    out.notes.push(`This brief shows the first ${limit} of ${items.length} returned item(s), in the order ` +
      "the API returned them. Every returned item is in the raw responses.");
  }
  const unstated = items.filter((i) => typeof i.qualifies !== "boolean");
  if (unstated.length) out.notes.push(`${unstated.length} evidence item(s) do not say whether they qualify.`);
  if (!items.length) out.notes.push("The evidence entry for this area holds no items.");
  const other: Json[] = [];
  if (name === "workforce") {
    for (const i of items) {
      const hits = otherOrg(i, companyId, names);
      if (hits.length) other.push({ ref: i.ref ?? null, fields: hits });
    }
    if (other.length) {
      out.flags.push(`${other.length} workforce evidence item(s) name a different organisation in fields ` +
        "the API returned. They are shown as returned, not removed.");
    }
  }
  out.evidence = {
    status: "returned", as_of: ev.as_of ?? null, framework_version: ev.framework_version ?? null,
    item_count: count, items_returned: items.length, truncated,
    qualifying_count: items.filter((i) => i.qualifies === true).length,
    not_qualifying_count: items.filter((i) => i.qualifies === false).length,
    unstated_count: unstated.length, shown_limit: limit, not_shown: items.length - shown.length,
    qualifying: shown.filter((i) => i.qualifies === true),
    not_qualifying: shown.filter((i) => i.qualifies === false),
    qualification_unstated: shown.filter((i) => typeof i.qualifies !== "boolean"),
    other_organisation_items: other,
  };
  return out;
}

export function aiSection(ans: Json, cfg: Json): Json {
  const c = ans.company;
  const nm = text(c.company_name);
  const names = nm ? [nm.toLowerCase()] : [];
  const dims = isObj(c.dimensions) ? c.dimensions : {};
  const available = isObj(c.evidence_available) ? c.evidence_available : {};
  const momentum = isObj(c.momentum) ? c.momentum : {};
  const level = c.overall_level ?? null;
  const notes: string[] = [];
  if (typeof level === "string" && !KNOWN_LEVELS.includes(level)) {
    notes.push(`The overall level ${level} is not one of the documented levels. It is shown as returned.`);
  }
  if (level === null) notes.push("The API returned no overall level.");
  if (cfg.with_evidence && !("evidence" in ans)) notes.push("No evidence was returned for any area.");
  return {
    firmable_id: c.firmable_id ?? null, company_name: c.company_name ?? null, country: c.country ?? null,
    industry_group: c.industry_group ?? null, size_band: c.size_band ?? null,
    overall_level: level,
    overall_level_documented: typeof level === "string" ? KNOWN_LEVELS.includes(level) : null,
    explanation: c.explanation ?? null,
    momentum: { label: momentum.label ?? null, signals: (Array.isArray(momentum.signals) ? momentum.signals : []).filter((x: unknown) => isObj(x)) },
    as_of: c.as_of ?? null, framework_version: c.framework_version ?? null,
    billable: isObj(ans.usage) ? ans.usage.billable ?? null : null,
    notes,
    areas: AREAS.map((a) => area(a, dims[a], available[a], ans.evidence, cfg, c.firmable_id ?? null, names)),
  };
}

function dataNotes(row: Row, subject: Record<string, string>, ai: Json): string[] {
  const out: string[] = [];
  const fid = text(ai.firmable_id);
  if (subject.type === "company_id" && fid && fid !== subject.value) {
    out.push(`You asked for company ID ${subject.value}; AI Adoption answered with company ID ${fid}.`);
  }
  const a = text(row.company_name), b = text(ai.company_name);
  if (a && b && a.toLowerCase() !== b.toLowerCase()) {
    out.push(`The input names the company "${a}"; AI Adoption names it "${b}". Both are shown as given.`);
  }
  return out;
}

// ----- run -------------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const coverage = [
    "Companies come from your input file. The REST API has no company search.",
    "Levels, explanations, headlines and momentum are shown as returned by the API. This code computes no " +
      "score, no trend and no narrative.",
    "Not observed means not observed in retrieved data. It does not mean the company has not adopted AI.",
    "Workforce evidence is checked for a different organisation only in fields the API returns that name an " +
      "organisation (company_id, firmable_id, organisation_id, company_name, employer, organisation, company). " +
      "The documented workforce item fields do not include an employer, so an item that belongs to another " +
      "organisation may not be detectable.",
    "An AI adoption level does not prove buying intent.",
  ];
  if (cfg.with_evidence) {
    coverage.push("AI Adoption checks before reading that your organisation could pay 3 credits for every " +
      "company in a batch. A batch of 25 companies with evidence needs 75 credits available.");
  } else {
    coverage.push("Evidence was not requested (with_evidence is false), so the briefs show levels and " +
      "headlines without evidence items.");
  }

  const subjects = new Map<string, Record<string, string>>();
  const externalIds = new Map<string, string>();
  const firstRow = new Map<string, string>();
  const keys: string[] = [];
  for (const r of ctx.rows) {
    const [subj] = subjectOf(r);
    if (subj && !subjects.has(keyOf(subj))) {
      subjects.set(keyOf(subj), subj);
      externalIds.set(keyOf(subj), r.row_id);
      firstRow.set(keyOf(subj), r.row_id);
      keys.push(keyOf(subj));
    }
  }
  const fetcher = new BatchFetcher(ctx, keys, subjects, externalIds, cfg.batch_size, cfg.with_evidence);
  const rowErrors = new Map<string, Json>();
  let dupes = 0;

  const one = async (row: Row): Promise<Json> => {
    const [subject, problem] = subjectOf(row);
    const base: Json = { row_id: row.row_id, input: row, subject, duplicate_of: null, ai_adoption: null, data_notes: [], brief_file: null };
    if (subject === null) return { ...base, status: "invalid_input", status_reason: problem };
    const key = keyOf(subject);
    if (firstRow.get(key) !== row.row_id) {
      base.duplicate_of = firstRow.get(key);
      dupes += 1;
    }
    const [kind, value] = await fetcher.get(key, row.row_id);
    if (kind === "error") {
      const msg = String(value.message ?? "").replace(/\.+$/, "");
      return { ...base, status: "error", status_reason: `AI Adoption could not be read: ${msg}.`, error: value };
    }
    if (kind === "mismatch") {
      if (!rowErrors.has(key)) rowErrors.set(key, ctx.recordErrorDict(row.row_id, value));
      return { ...base, status: "error", status_reason: value.message, error: rowErrors.get(key) };
    }
    const outcome = classify(value);
    if (outcome === "row_error") {
      if (!rowErrors.has(key)) {
        const err = value.error ?? {};
        rowErrors.set(key, ctx.recordErrorDict(row.row_id, rowError(err.code, err.message)));
      }
      return { ...base, status: "error", status_reason: rowErrors.get(key).message + ".", error: rowErrors.get(key) };
    }
    if (outcome === "not_found") {
      const err = isObj(value.error) ? value.error : {};
      base.ai_adoption = { error_code: err.code ?? null, error_message: err.message ?? null,
        billable: isObj(value.usage) ? value.usage.billable ?? null : null };
      return { ...base, status: "not_found",
        status_reason: "Firmable holds no AI adoption data for this company, or could not match it. " +
          "This is not a finding of no AI adoption." };
    }
    const ai = aiSection(value, cfg);
    base.ai_adoption = ai;
    base.data_notes = dataNotes(row, subject, ai);
    return { ...base, status: "brief_ready",
      status_reason: `Overall level ${text(ai.overall_level) ?? "not returned"}, as of ${text(ai.as_of) ?? "an unstated date"}.` };
  };

  const rows = await ctx.runRows(ctx.rows, one);
  assignBriefFiles(rows);

  const counts: Record<string, number> = {};
  const levels: Record<string, number> = {};
  let flagged = 0;
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === "brief_ready" && !r.duplicate_of) {
      const lv = text(r.ai_adoption.overall_level) ?? "not returned";
      levels[lv] = (levels[lv] ?? 0) + 1;
      if (r.ai_adoption.areas.some((a: Json) => a.flags.length)) flagged += 1;
    }
  }
  if (dupes) {
    coverage.push(`${dupes} row(s) repeat an earlier company; the earlier answer was reused and no brief ` +
      "file was written for the repeat.");
  }
  if (flagged) {
    coverage.push(`${flagged} brief(s) have missing, truncated or questionable evidence flagged in at least ` +
      "one area.");
  }
  if (rows.some((r) => r.data_notes && r.data_notes.length)) {
    coverage.push("Some company facts differ between your input and AI Adoption. Both values are shown; " +
      "this code does not correct upstream data.");
  }
  const summary = {
    companies_in_input: rows.length, unique_companies_asked: keys.length, status_counts: counts,
    overall_level_counts: levels, briefs_written: rows.filter((r) => r.brief_file && !r.duplicate_of).length,
  };
  return { rows, summary, coverage };
}

function assignBriefFiles(rows: Json[]): void {
  const used = new Set<string>();
  const byRow = new Map<string, string>();
  for (const r of rows) {
    if (!["brief_ready", "not_found"].includes(r.status) || r.duplicate_of) continue;
    const stem = "ai-brief-" + String(r.row_id).replace(SAFE_NAME, "_");
    let name = `${stem}.md`;
    let n = 2;
    while (used.has(name)) { name = `${stem}-${n}.md`; n += 1; }
    used.add(name);
    r.brief_file = name;
    byRow.set(r.row_id, name);
  }
  for (const r of rows) {
    if (r.duplicate_of && ["brief_ready", "not_found"].includes(r.status)) r.brief_file = byRow.get(r.duplicate_of) ?? null;
  }
}

// ----- Markdown --------------------------------------------------------------------------------

/** Escapes Markdown special characters in API or input text and keeps it on one line. */
export function md(value: unknown): string {
  const t = s(value).replace(/\r\n/g, " ").replace(/\r/g, " ").replace(/\n/g, " ");
  let out = "";
  for (const ch of t) out += MD_SPECIAL.has(ch) ? "\\" + ch : ch;
  return out.startsWith("#") ? "\\" + out : out;
}

const mv = (value: unknown): string => (value === null || value === undefined || value === "" ? "not returned" : md(value));

function fieldText(v: unknown): string {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) return v.map((x) => s(x)).join(", ");
  return s(v);
}

export function itemFields(item: Json): string {
  return Object.entries(item).filter(([k]) => k !== "ref" && k !== "qualifies").map(([k, v]) => `${k}: ${fieldText(v)}`).join("; ");
}

export function itemRef(item: Json): string {
  const ref = isObj(item.ref) ? item.ref : {};
  return (s(ref.type) + " " + s(ref.id)).trim() || "not returned";
}

function itemsMd(title: string, items: Json[], total: number): string[] {
  const lines = [`**${title}** (${total} returned, ${items.length} shown)`, ""];
  if (!items.length) return [...lines, "None shown.", ""];
  lines.push("| Reference (`ref`) | Fields as returned |", "| - | - |");
  for (const i of items) lines.push(`| ${md(itemRef(i))} | ${md(itemFields(i))} |`);
  return [...lines, ""];
}

const capitalise = (x: string): string => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();

export function briefMarkdown(r: Json): string {
  const ai = r.ai_adoption ?? {};
  const found = r.status === "brief_ready";
  const name = (found ? ai.company_name : null) || r.input.company_name || r.subject.value;
  const subj = r.subject;
  const lines = [`# AI adoption brief: ${md(name)}`, "",
    "Every fact below is an AI Adoption field as the API returned it, with the field name in brackets. " +
    "This brief adds no score, no trend and no narrative.", "",
    "## Company", "", "| Field | Value |", "| - | - |",
    `| Row | ${md(r.row_id)} |`,
    `| Asked by | ${md(subj.type)} ${md(subj.value)} |`];
  if (r.input.company_name) lines.push(`| Name in your input | ${md(r.input.company_name)} |`);
  if (found) {
    for (const [label, field] of [["Firmable ID", "firmable_id"], ["Company name", "company_name"], ["Country", "country"],
      ["Industry group", "industry_group"], ["Size band", "size_band"], ["Data as of", "as_of"],
      ["Framework version", "framework_version"]]) {
      lines.push(`| ${label} (\`${field}\`) | ${mv(ai[field])} |`);
    }
  }
  lines.push("");
  for (const n of r.data_notes ?? []) lines.push(`Note: ${md(n)}`, "");
  if (!found) {
    lines.push("## AI adoption", "",
      "Firmable holds no AI adoption data for this company, or could not match it. This is not a finding " +
      "of no AI adoption.", "",
      `Error code as returned: ${mv(ai.error_code)}. Message as returned: ${mv(ai.error_message)}.`, "");
    return [...lines, ...readingMd()].join("\n");
  }
  lines.push("## Overall level", "",
    `- Level (\`overall_level\`): ${mv(ai.overall_level)}`,
    `- Explanation (\`explanation\`), as returned: ${mv(ai.explanation)}`);
  for (const n of ai.notes ?? []) lines.push(`- Note: ${md(n)}`);
  const m = ai.momentum ?? {};
  lines.push("", "## Momentum", "", `- Label (\`momentum.label\`): ${mv(m.label)}`, "");
  if (m.signals && m.signals.length) {
    lines.push("| Signal kind (`kind`) | Count (`count`) | Latest (`latest`) |", "| - | - | - |");
    for (const x of m.signals) lines.push(`| ${mv(x.kind)} | ${mv(x.count)} | ${mv(x.latest)} |`);
  } else {
    lines.push("No momentum signals were returned.");
  }
  lines.push("", "## Areas", "",
    "| Area | Level | Observability | Counts toward overall | Evidence held (`evidence_available`) |",
    "| - | - | - | - | - |");
  for (const a of ai.areas) {
    lines.push(`| ${a.area} | ${mv(a.level)} | ${mv(a.observability)} | ${mv(a.counts_toward_overall)} | ${mv(a.evidence_available)} |`);
  }
  lines.push("");
  for (const a of ai.areas) lines.push(...areaMd(a));
  lines.push("## Not observed", "");
  const missing = ai.areas.filter((a: Json) => (a.evidence ?? {}).status === "not_returned" || !a.level);
  if (ai.areas.length && ai.areas[0].evidence.status === "not_requested") {
    lines.push("Evidence was not requested for this run, so this brief cannot say which areas have evidence.");
  } else if (missing.length) {
    for (const a of missing) {
      const what = !a.level ? "the API returned no level" : "no evidence was returned";
      lines.push(`- ${a.area}: ${what}. Not observed in retrieved data; this does not mean the company ` +
        "has no AI activity in this area.");
    }
  } else {
    lines.push("Every area returned a level and evidence.");
  }
  lines.push("");
  return [...lines, ...readingMd()].join("\n");
}

function areaMd(a: Json): string[] {
  const ev = a.evidence ?? {};
  const lines = [`### ${capitalise(a.area)}`, "",
    `- Level (\`level\`): ${mv(a.level)}`,
    `- Headline (\`headline\`), as returned: ${mv(a.headline)}`,
    `- Observability (\`observability\`): ${mv(a.observability)}`,
    `- Counts toward overall (\`counts_toward_overall\`): ${mv(a.counts_toward_overall)}`,
    `- Evidence held (\`evidence_available\`): ${mv(a.evidence_available)}`];
  if (ev.status === "returned") {
    lines.push(`- Evidence returned: ${ev.items_returned} of ${mv(ev.item_count)} item(s) ` +
      `(\`item_count\`), as of ${mv(ev.as_of)}, truncated: ${s(ev.truncated)}`);
  } else if (ev.status === "not_returned") {
    lines.push("- Evidence returned: none");
  } else {
    lines.push("- Evidence returned: not requested");
  }
  for (const f of a.flags) lines.push(`- Flag: ${md(f)}`);
  for (const n of a.notes) lines.push(`- Note: ${md(n)}`);
  lines.push("");
  if (ev.status === "returned") {
    lines.push(...itemsMd("Qualifying evidence (`qualifies` true)", ev.qualifying, ev.qualifying_count));
    lines.push(...itemsMd("Evidence that does not qualify (`qualifies` false)", ev.not_qualifying, ev.not_qualifying_count));
    if (ev.unstated_count) {
      lines.push(...itemsMd("Evidence that does not say whether it qualifies", ev.qualification_unstated, ev.unstated_count));
    }
  }
  return lines;
}

function readingMd(): string[] {
  return ["## How to read this brief", "",
    "- Levels, explanations and headlines are the API's own words. They are not rewritten.",
    "- Qualifying evidence counts towards an area's level. Evidence that does not qualify was found but " +
    "does not count.",
    "- Not observed means not observed in retrieved data. It does not mean the company has not adopted AI.",
    "- An AI adoption level does not prove buying intent.", ""];
}

export function markdown(result: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of result.rows) if (r.brief_file && !r.duplicate_of) out[r.brief_file] = briefMarkdown(r);
  return out;
}

// ----- CSV and report --------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "asked_by", "asked_value", "duplicate_of", "status", "status_reason", "firmable_id",
  "company_name", "overall_level", "momentum_label", "architecture_level", "footprint_level",
  "hiring_level", "initiatives_level", "workforce_level", "evidence_items_returned",
  "truncated_areas", "flags", "as_of", "brief_file"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const ai = r.ai_adoption ?? {};
    const areas: Json[] = ai.areas ?? [];
    const subject = r.subject ?? {};
    const flags: string[] = [...(r.data_notes ?? [])];
    for (const a of areas) for (const f of a.flags) flags.push(`${a.area}: ${f}`);
    const returned = areas.filter((a) => a.evidence.status === "returned").map((a) => a.evidence.items_returned as number);
    const row: Record<string, unknown> = {
      row_id: r.row_id, asked_by: subject.type,
      asked_value: subject.value || r.input.company_id || r.input.domain,
      duplicate_of: r.duplicate_of, status: r.status, status_reason: r.status_reason ?? r.reason,
      firmable_id: ai.firmable_id, company_name: ai.company_name,
      overall_level: ai.overall_level, momentum_label: (ai.momentum ?? {}).label,
      evidence_items_returned: returned.length ? returned.reduce((x, y) => x + y, 0) : null,
      truncated_areas: areas.filter((a) => a.evidence.truncated).map((a) => a.area),
      flags, as_of: ai.as_of, brief_file: r.brief_file,
    };
    for (const a of AREAS) row[`${a}_level`] = (areas.find((x) => x.area === a) ?? {}).level;
    return row;
  });
}

function itemsTable(items: Json[]): string {
  return table(["Reference", "Fields as returned"], items.map((i) => [itemRef(i), itemFields(i)]));
}

function areaHtml(a: Json): string {
  let html = `<h3>${esc(capitalise(a.area))}: ${esc(a.level || "no level returned")}</h3>`;
  html += a.headline ? `<p>${esc(a.headline)}</p>` : '<p class="muted">No headline returned.</p>';
  for (const f of a.flags) html += note(esc(f), "review");
  for (const n of a.notes) html += note(esc(n), "unknown");
  const ev = a.evidence ?? {};
  if (ev.status === "returned") {
    html += `<p class="muted">Evidence as of ${esc(ev.as_of)}: ${esc(ev.items_returned)} of ${esc(s(ev.item_count))} item(s) returned` +
      (ev.truncated ? ", truncated" : "") + ".</p>";
    if (ev.qualifying.length) html += `<p><strong>Qualifying evidence</strong> (${ev.qualifying_count} returned)</p>` + itemsTable(ev.qualifying);
    if (ev.not_qualifying.length) {
      html += `<p><strong>Evidence that does not qualify</strong> (${ev.not_qualifying_count} returned)</p>` + itemsTable(ev.not_qualifying);
    }
    if (ev.qualification_unstated.length) {
      html += "<p><strong>Evidence that does not say whether it qualifies</strong></p>" + itemsTable(ev.qualification_unstated);
    }
  }
  return html;
}

export function render(report: Report, result: Json): void {
  const counts: Record<string, number> = result.summary.status_counts ?? {};
  report.add("Result", "Brief summary",
    "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>" +
    note("Levels, explanations and headlines are the API's own words. This report computes no score " +
      "and no trend. Not observed means not observed in retrieved data, not no adoption.", "unknown"));
  const cards: string[] = [];
  for (const r of result.rows) {
    const status: string = r.status;
    const ai = r.ai_adoption ?? {};
    const subject = r.subject ?? null;
    const title = ai.company_name || r.input.company_name || (subject ? subject.value : null) || r.row_id;
    const reason = r.status_reason || r.reason || "";
    let left = `<p>${esc(reason)}</p>`;
    if (subject) left += kv([["Asked by", `${subject.type} ${subject.value}`], ["Brief file", r.brief_file]]);
    if (r.duplicate_of) left += note(`Same company as row ${esc(r.duplicate_of)}; the answer was reused.`, "info");
    for (const n of r.data_notes ?? []) left += note(esc(n), "review");
    let right = "";
    if (status === "brief_ready") {
      const m = ai.momentum ?? {};
      left += "<h3>AI Adoption</h3>" + kv([
        ["Firmable ID", ai.firmable_id], ["Country", ai.country], ["Industry group", ai.industry_group],
        ["Size band", ai.size_band], ["Overall level", ai.overall_level], ["Explanation", ai.explanation],
        ["Momentum", m.label],
        ["Momentum signals", (m.signals ?? []).map((x: Json) => `${s(x.kind)}: ${s(x.count)}, latest ${s(x.latest)}`).join("; ") || null],
        ["Data as of", ai.as_of], ["Framework version", ai.framework_version]]);
      for (const n of ai.notes ?? []) left += note(esc(n), "unknown");
      right += table(["Area", "Level", "Observability", "Counts toward overall", "Evidence held", "Flags"],
        ai.areas.map((a: Json) => [a.area, a.level, a.observability, a.counts_toward_overall, s(a.evidence_available), a.flags.length]));
      right += ai.areas.map(areaHtml).join("");
      right += detailsJson("Area detail as returned", Object.fromEntries(ai.areas.map((a: Json) => [a.area, a.detail])));
    } else if (status === "not_found") {
      left += note("Firmable holds no AI adoption data for this company, or could not match it. This is not a " +
        "finding of no AI adoption.", "unknown");
    }
    cards.push(card(String(title), badge(status.replace(/_/g, " "), STATUS_TONE[status] ?? "neutral"), left,
      right || '<p class="muted">No evidence to show for this row.</p>', `Row ${r.row_id}`));
  }
  report.add("Companies", "Each company brief", cards.join(""));
  report.add("Reading the briefs", "How to read the briefs", bulletList(readingMd().slice(2, -1).map((l) => raw(esc(l.slice(2))))));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render, markdown,
};
