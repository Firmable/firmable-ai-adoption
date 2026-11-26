/**
 * AI outreach angles: per-account talk angles filled from fixed templates and AI Adoption facts.
 * Mirrors recipes/ai-outreach-angles/python/src/ai_outreach_angles/recipe.py; see that file and the
 * recipe README for the matching and template rules. Angles are suggestions, not facts.
 */
import {
  ConfigError, ErrorDict, FirmableError, InvalidResponseError, Json, PlannedCall, Recipe, Report, RunContext, Row,
  badge, bulletList, card, esc, kv, normaliseDomain, note, pricing, raw, readRows, table,
} from "firmable-api-client";

export const NAME = "ai-outreach-angles";
export const TITLE = "AI outreach angles";
export const DESCRIPTION = "Suggests outreach angles for each account from fixed templates, filled only with AI Adoption facts " +
  "and your input, and shows each angle beside the facts it used.";

const AREAS = ["architecture", "footprint", "hiring", "initiatives", "workforce"];
const PLACEHOLDERS = ["company_name", "overall_level", "dimension", "dimension_level", "headline", "momentum"];
const DIMENSION_PLACEHOLDERS = new Set(["dimension", "dimension_level", "headline"]);
const TOP_KEYS = new Set(["angles", "batch_size"]);
const WHEN_KEYS = new Set(["overall_level_in", "dimension", "momentum_in"]);
const MAX_ANGLES = 20;
const STATUS_TONE: Record<string, string> = {
  angles_found: "good", no_angle: "neutral", not_found: "unknown", invalid_input: "error", error: "error",
  not_processed: "unknown",
};
const ID = /^[a-z0-9_]{1,40}$/;
const TOKEN = /\{([^{}]*)\}/g;
const COMPANY_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const MD_SPECIAL = new Set(["\\", "`", "*", "_", "[", "]", "<", ">", "|"]);

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

// ----- configuration and input -----------------------------------------------------------------

function whole(rawCfg: Json, key: string, def: number, lo: number, hi: number): number {
  const v = rawCfg[key] ?? def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new ConfigError(`${key} must be a whole number from ${lo} to ${hi}.`);
  }
  return v;
}

function values(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x.trim())) {
    throw new ConfigError(`${where} must be a non-empty list of non-empty text values.`);
  }
  return (v as string[]).map((x) => x.trim());
}

function placeholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function loadConfig(rawCfg: Json): Json {
  const unknown = Object.keys(rawCfg).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const anglesRaw = rawCfg.angles;
  if (!Array.isArray(anglesRaw) || anglesRaw.length < 1 || anglesRaw.length > MAX_ANGLES) {
    throw new ConfigError(`angles must be a list of 1 to ${MAX_ANGLES} angles.`);
  }
  const angles: Json[] = [];
  const seen = new Set<string>();
  anglesRaw.forEach((a: Json, idx: number) => {
    const where = `angles[${idx + 1}]`;
    if (!isObj(a)) throw new ConfigError(`${where} must be an object.`);
    let extra = Object.keys(a).filter((k) => !["id", "when", "template"].includes(k)).sort();
    if (extra.length) throw new ConfigError(`${where} has unknown key(s): ${extra.join(", ")}`);
    const aid = a.id;
    if (typeof aid !== "string" || !ID.test(aid)) throw new ConfigError(`${where}.id must be 1 to 40 lower-case letters, digits or underscores.`);
    if (seen.has(aid)) throw new ConfigError(`${where}.id '${aid}' is used twice.`);
    seen.add(aid);
    const whenRaw = a.when;
    if (!isObj(whenRaw) || !Object.keys(whenRaw).length) {
      throw new ConfigError(`${where}.when must be an object with at least one of overall_level_in, dimension, ` +
        "momentum_in.");
    }
    extra = Object.keys(whenRaw).filter((k) => !WHEN_KEYS.has(k)).sort();
    if (extra.length) throw new ConfigError(`${where}.when has unknown key(s): ${extra.join(", ")}`);
    const when: Json = {};
    if ("overall_level_in" in whenRaw) when.overall_level_in = values(whenRaw.overall_level_in, `${where}.when.overall_level_in`);
    if ("dimension" in whenRaw) {
      const d = whenRaw.dimension;
      if (!isObj(d) || Object.keys(d).sort().join(",") !== "level_in,name") {
        throw new ConfigError(`${where}.when.dimension must be an object with name and level_in only.`);
      }
      if (!AREAS.includes(d.name)) throw new ConfigError(`${where}.when.dimension.name must be one of ${AREAS.join(", ")}.`);
      when.dimension = { name: d.name, level_in: values(d.level_in, `${where}.when.dimension.level_in`) };
    }
    if ("momentum_in" in whenRaw) when.momentum_in = values(whenRaw.momentum_in, `${where}.when.momentum_in`);
    const template = a.template;
    if (typeof template !== "string" || !template.trim()) throw new ConfigError(`${where}.template must be non-empty text.`);
    const rest = template.replace(TOKEN, "");
    if (rest.includes("{") || rest.includes("}")) throw new ConfigError(`${where}.template has an unmatched brace.`);
    const names = placeholders(template);
    for (const name of names) {
      if (!PLACEHOLDERS.includes(name)) {
        throw new ConfigError(`${where}.template uses {${name}}, which is not one of: ` +
          PLACEHOLDERS.map((p) => `{${p}}`).join(", ") + ".");
      }
      if (DIMENSION_PLACEHOLDERS.has(name) && !("dimension" in when)) {
        throw new ConfigError(`${where}.template uses {${name}}, which needs when.dimension.`);
      }
    }
    angles.push({ id: aid, when, template: template.trim(), placeholders: names });
  });
  return { angles, batch_size: whole(rawCfg, "batch_size", 100, 1, 100) };
}

export function readInput(path: string): Row[] {
  return readRows(path, { anyOf: ["domain", "company_id"] });
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

const keyOf = (x: Record<string, string>): string => `${x.type}:${x.value}`;

function uniqueSubjects(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const [subj] = subjectOf(r);
    if (subj && !out.includes(keyOf(subj))) out.push(keyOf(subj));
  }
  return out;
}

export function plan(rows: Row[], config: Json): PlannedCall[] {
  const n = uniqueSubjects(rows).length;
  const size: number = config.batch_size;
  return [new PlannedCall("POST /ai-adoption", `AI Adoption for each unique valid account, in batches of up to ${size}`,
    Math.ceil(n / size), pricing.estimateAiAdoption(n, false))];
}

// ----- batched AI Adoption ---------------------------------------------------------------------

export function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

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
    readonly externalIds: Map<string, string>, batchSize: number) {
    for (let i = 0; i < keys.length; i += batchSize) this.batches.push({ keys: keys.slice(i, i + batchSize), status: "pending", error: null });
    keys.forEach((k, i) => this.batchOf.set(k, Math.floor(i / batchSize)));
  }

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
      const resp = await this.ctx.client.getAiAdoption({ records });
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

// ----- angles ----------------------------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function companyFacts(c: Json): Json {
  const dims = isObj(c.dimensions) ? c.dimensions : {};
  const momentum = isObj(c.momentum) ? c.momentum : {};
  const dimensions: Json = {};
  for (const a of AREAS) dimensions[a] = isObj(dims[a]) ? { level: dims[a].level ?? null, headline: dims[a].headline ?? null } : null;
  return {
    firmable_id: c.firmable_id ?? null, company_name: c.company_name ?? null,
    overall_level: c.overall_level ?? null, momentum_label: momentum.label ?? null,
    as_of: c.as_of ?? null, framework_version: c.framework_version ?? null, dimensions,
  };
}

function check(condition: string, field: string, returned: unknown, wanted: string[]): Json {
  const t = text(returned);
  const result = t === null ? "unknown" : wanted.map((w) => w.toUpperCase()).includes(t.toUpperCase()) ? "yes" : "no";
  return { condition, field, returned: returned ?? null, wanted, result };
}

export function evaluate(angle: Json, facts: Json, row: Row): Json {
  const when = angle.when;
  const checks: Json[] = [];
  if (when.overall_level_in) checks.push(check("overall_level_in", "overall_level", facts.overall_level, when.overall_level_in));
  const dim = when.dimension ?? null;
  const dimFacts = dim ? facts.dimensions[dim.name] ?? {} : {};
  if (dim) checks.push(check("dimension.level_in", `dimensions.${dim.name}.level`, dimFacts.level, dim.level_in));
  if (when.momentum_in) checks.push(check("momentum_in", "momentum.label", facts.momentum_label, when.momentum_in));
  if (checks.some((c) => c.result === "no")) return { id: angle.id, result: "not_matched", conditions: checks };
  if (checks.some((c) => c.result === "unknown")) {
    return { id: angle.id, result: "not_evaluated", conditions: checks,
      unknown_fields: checks.filter((c) => c.result === "unknown").map((c) => c.field) };
  }
  const sources: Record<string, [string | null, string]> = {
    company_name: text(facts.company_name) ? [text(facts.company_name), "AI Adoption company_name"]
      : [text(row.company_name), "input company_name"],
    overall_level: [text(facts.overall_level), "AI Adoption overall_level"],
    momentum: [text(facts.momentum_label), "AI Adoption momentum.label"],
  };
  if (dim) {
    sources.dimension = [dim.name, "configuration when.dimension.name"];
    sources.dimension_level = [text(dimFacts.level), `AI Adoption dimensions.${dim.name}.level`];
    sources.headline = [text(dimFacts.headline), `AI Adoption dimensions.${dim.name}.headline`];
  }
  const used: Json[] = [];
  const missing: string[] = [];
  for (const name of angle.placeholders as string[]) {
    const [value, source] = sources[name];
    if (value === null) missing.push(name);
    else used.push({ placeholder: name, value, source });
  }
  if (missing.length) return { id: angle.id, result: "skipped", conditions: checks, missing };
  const vals: Record<string, string> = Object.fromEntries(used.map((u) => [u.placeholder, u.value]));
  const filled = (angle.template as string).replace(TOKEN, (_m: string, name: string) => vals[name]);
  return { id: angle.id, result: "filled", kind: "suggested_angle", text: filled, template: angle.template,
    conditions: checks, filled_from: used };
}

// ----- run -------------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const coverage = [
    "Accounts come from your input file. The REST API has no company search.",
    "Angles are filled from fixed templates in the configuration, using only AI Adoption facts and the input " +
      "company_name. They are suggestions, not facts.",
    "Levels and labels are matched by name only. This code does not order levels, compute a score or infer " +
      "a trend.",
    "An AI adoption level or momentum label does not prove buying intent.",
    "No angle is produced for an account without AI adoption data. That is not a finding of no AI adoption.",
    "A condition on a fact the API did not return cannot be checked. The angle is listed as not evaluated, " +
      "not as failed.",
  ];
  const subjects = new Map<string, Record<string, string>>();
  const externalIds = new Map<string, string>();
  const keys: string[] = [];
  for (const r of ctx.rows) {
    const [subj] = subjectOf(r);
    if (subj && !subjects.has(keyOf(subj))) {
      subjects.set(keyOf(subj), subj);
      externalIds.set(keyOf(subj), r.row_id);
      keys.push(keyOf(subj));
    }
  }
  const fetcher = new BatchFetcher(ctx, keys, subjects, externalIds, cfg.batch_size);
  const rowErrors = new Map<string, Json>();
  let dupes = 0;

  const one = async (row: Row): Promise<Json> => {
    const [subject, problem] = subjectOf(row);
    const base: Json = { row_id: row.row_id, input: row, subject, duplicate_of: null, company: null, angles: [],
      skipped_angles: [], not_evaluated_angles: [], not_matched_angles: [] };
    if (subject === null) return { ...base, status: "invalid_input", status_reason: problem };
    const key = keyOf(subject);
    if (externalIds.get(key) !== row.row_id) {
      base.duplicate_of = externalIds.get(key);
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
      return { ...base, status: "not_found",
        status_reason: "Firmable holds no AI adoption data for this account, or could not match it, so " +
          "no angle was produced. This is not a finding of no AI adoption." };
    }
    const facts = companyFacts(value.company);
    base.company = facts;
    for (const angle of cfg.angles) {
      const res = evaluate(angle, facts, row);
      if (res.result === "filled") base.angles.push(res);
      else if (res.result === "skipped") base.skipped_angles.push({ id: res.id, missing: res.missing });
      else if (res.result === "not_evaluated") base.not_evaluated_angles.push({ id: res.id, unknown_fields: res.unknown_fields });
      else base.not_matched_angles.push(res.id);
    }
    const n = base.angles.length;
    if (n) return { ...base, status: "angles_found", status_reason: `${n} angle(s) matched the returned facts and were filled.` };
    return { ...base, status: "no_angle", status_reason: "No angle matched the returned facts and could be filled." };
  };

  const rows = await ctx.runRows(ctx.rows, one);
  const counts: Record<string, number> = {};
  const angleCounts: Record<string, number> = {};
  for (const a of cfg.angles) angleCounts[a.id] = 0;
  const skipped: Record<string, number> = {};
  const notEvaluated: Record<string, number> = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.duplicate_of) continue;
    for (const a of r.angles ?? []) angleCounts[a.id] += 1;
    for (const a of r.skipped_angles ?? []) skipped[a.id] = (skipped[a.id] ?? 0) + 1;
    for (const a of r.not_evaluated_angles ?? []) notEvaluated[a.id] = (notEvaluated[a.id] ?? 0) + 1;
  }
  const withData = rows.filter((r) => !r.duplicate_of && ["angles_found", "no_angle"].includes(r.status)).length;
  if (dupes) coverage.push(`${dupes} row(s) repeat an earlier account; the earlier answer was reused, not requested again.`);
  if (Object.keys(skipped).length) {
    coverage.push("Some matching angles were skipped because a placeholder had no value: " +
      Object.entries(skipped).map(([k, v]) => `${k} (${v} account(s))`).join(", ") + ".");
  }
  if (Object.keys(notEvaluated).length) {
    coverage.push("Some angles could not be evaluated because a fact they need was not returned: " +
      Object.entries(notEvaluated).map(([k, v]) => `${k} (${v} account(s))`).join(", ") + ".");
  }
  const summary = {
    rows_in_input: rows.length, unique_accounts_asked: keys.length, accounts_with_data: withData,
    status_counts: counts, angle_counts_among_accounts_with_data: angleCounts,
    skipped_angle_counts: skipped, not_evaluated_angle_counts: notEvaluated,
  };
  return { rows, summary, coverage };
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
const conditionLabel = (c: Json): string => `Condition: ${c.field} is one of ${c.wanted.join(", ")}`;

function accountName(r: Json): string {
  return (r.company ?? {}).company_name || r.input.company_name || (r.subject ?? {}).value || r.input.domain ||
    r.input.company_id || r.row_id;
}

export function outreachMarkdown(result: Json): string {
  const lines = ["# Outreach angles", "",
    "Each angle is filled from a fixed template in the configuration, using only AI Adoption facts and the " +
    "company name in your input. An angle is a suggestion, not a fact. An AI adoption level or momentum " +
    "label does not prove buying intent.", ""];
  for (const r of result.rows) {
    lines.push(`## ${md(accountName(r))} (row ${md(r.row_id)})`, "");
    if (r.duplicate_of) {
      lines.push(`Same account as row ${md(r.duplicate_of)}. The angles are the same as for that row.`, "");
      continue;
    }
    const c = r.company;
    if (!["angles_found", "no_angle"].includes(r.status)) {
      lines.push(`No angle: ${md(r.status_reason || r.reason || "")}`, "");
      continue;
    }
    lines.push("| Fact | Value as returned |", "| - | - |",
      `| Overall level (\`overall_level\`) | ${mv(c.overall_level)} |`,
      `| Momentum (\`momentum.label\`) | ${mv(c.momentum_label)} |`,
      `| Data as of (\`as_of\`) | ${mv(c.as_of)} |`, "");
    if (!r.angles.length) lines.push("No angle matched the returned facts and could be filled.", "");
    for (const a of r.angles) {
      lines.push(`### Angle \`${a.id}\``, "", "> **Suggested, not a fact**", ">", `> ${md(a.text)}`, "",
        "| Used for this angle | Value | Source |", "| - | - | - |");
      for (const ch of a.conditions) lines.push(`| ${md(conditionLabel(ch))} | ${mv(ch.returned)} | AI Adoption \`${ch.field}\` |`);
      for (const u of a.filled_from) lines.push(`| Placeholder \`{${u.placeholder}}\` | ${md(u.value)} | ${md(u.source)} |`);
      lines.push("");
    }
    if (r.skipped_angles.length) {
      lines.push("Matching angles skipped because a placeholder had no value:", "");
      for (const x of r.skipped_angles) lines.push(`- \`${x.id}\`: missing ` + x.missing.map((m: string) => `\`{${m}}\``).join(", "));
      lines.push("");
    }
    if (r.not_evaluated_angles.length) {
      lines.push("Angles not evaluated because a fact they need was not returned:", "");
      for (const x of r.not_evaluated_angles) {
        lines.push(`- \`${x.id}\`: ` + x.unknown_fields.map((f: string) => `\`${f}\``).join(", ") + " not returned");
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function markdown(result: Json): Record<string, string> {
  return { "outreach-angles.md": outreachMarkdown(result) };
}

// ----- CSV and report --------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "asked_by", "asked_value", "company_name", "segment", "duplicate_of", "status",
  "status_reason", "overall_level", "momentum_label", "angle_ids", "suggested_angles",
  "skipped_angles", "not_evaluated_angles", "firmable_id", "as_of"];

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const c = r.company ?? {};
    const subject = r.subject ?? {};
    return {
      row_id: r.row_id, asked_by: subject.type,
      asked_value: subject.value || r.input.company_id || r.input.domain,
      company_name: c.company_name || r.input.company_name,
      segment: r.input.segment, duplicate_of: r.duplicate_of, status: r.status,
      status_reason: r.status_reason || r.reason,
      overall_level: c.overall_level, momentum_label: c.momentum_label,
      angle_ids: (r.angles ?? []).map((a: Json) => a.id),
      suggested_angles: (r.angles ?? []).map((a: Json) => a.text),
      skipped_angles: (r.skipped_angles ?? []).map((a: Json) => a.id),
      not_evaluated_angles: (r.not_evaluated_angles ?? []).map((a: Json) => a.id),
      firmable_id: c.firmable_id, as_of: c.as_of,
    };
  });
}

export function render(report: Report, result: Json): void {
  const sm = result.summary;
  const counts: Record<string, number> = sm.status_counts ?? {};
  let body = "<p>" + Object.entries(counts).map(([k, v]) => badge(`${k.replace(/_/g, " ")}: ${v}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>";
  body += table(["Angle", "Accounts where it was filled", "Out of"],
    Object.entries(sm.angle_counts_among_accounts_with_data ?? {}).map(([k, v]) => [k, v, `${sm.accounts_with_data} accounts with AI adoption data`]));
  body += note("Angles are suggestions from fixed templates, not facts. An AI adoption level or momentum label " +
    "does not prove buying intent.", "unknown");
  report.add("Result", "Angle summary", body);
  const cards: string[] = [];
  for (const r of result.rows) {
    const status: string = r.status;
    const c = r.company;
    let left = `<p>${esc(r.status_reason || r.reason || "")}</p>`;
    if (r.duplicate_of) left += note(`Same account as row ${esc(r.duplicate_of)}; the answer was reused.`, "info");
    let right = "";
    if (c) {
      left += "<h3>Facts as returned</h3>" + kv([
        ["Firmable ID", c.firmable_id], ["Overall level", c.overall_level],
        ["Momentum label", c.momentum_label], ["Data as of", c.as_of]]);
      left += table(["Area", "Level", "Headline"], AREAS.map((a) => [a, (c.dimensions[a] ?? {}).level, (c.dimensions[a] ?? {}).headline]));
      for (const a of r.angles) {
        const facts: unknown[][] = a.conditions.map((ch: Json) => [conditionLabel(ch), ch.returned, ch.field]);
        for (const u of a.filled_from) facts.push([`{${u.placeholder}}`, u.value, u.source]);
        right += `<div class="template"><p><strong>Suggested, not a fact</strong> (${esc(a.id)})</p>` +
          `<p>${esc(a.text)}</p>` + table(["Used", "Value", "Source"], facts) + "</div>";
      }
      const extra = [
        ...r.skipped_angles.map((x: Json) => raw(esc(`${x.id}: skipped, missing ${x.missing.join(", ")}`))),
        ...r.not_evaluated_angles.map((x: Json) => raw(esc(`${x.id}: not evaluated, ${x.unknown_fields.join(", ")} not returned`))),
      ];
      if (extra.length) right += '<p class="muted">Angles not produced:</p>' + bulletList(extra);
    }
    cards.push(card(String(accountName(r)), badge(status.replace(/_/g, " "), STATUS_TONE[status] ?? "neutral"),
      left, right || '<p class="muted">No angle for this row.</p>', `Row ${r.row_id}`));
  }
  report.add("Accounts", "Angles for each account", cards.join(""));
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render, markdown,
};
