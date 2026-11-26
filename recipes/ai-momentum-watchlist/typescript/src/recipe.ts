/**
 * AI momentum watchlist: which accounts show recent AI momentum worth acting on now.
 * Mirrors recipes/ai-momentum-watchlist/python/src/ai_momentum_watchlist/recipe.py; see that file and
 * the recipe README for the watch rule. Momentum does not prove buying intent.
 */
import {
  ConfigError, ErrorDict, FirmableError, InvalidResponseError, Json, PlannedCall, Recipe, Report, RunContext, Row,
  badge, esc, normaliseDomain, note, parseDate, pricing, raw, readRows, table,
} from "firmable-api-client";

export const NAME = "ai-momentum-watchlist";
export const TITLE = "AI momentum watchlist";
export const DESCRIPTION = "Flags accounts whose AI Adoption momentum label is one you chose and whose momentum signals are " +
  "recent, with every label, signal and date shown as returned.";

const TOP_KEYS = new Set(["labels", "signal_kinds", "recent_days", "evaluation_date", "batch_size"]);
const STATUS_ORDER = ["watch", "label_only", "not_watch", "not_found", "invalid_input", "error", "not_processed"];
const STATUS_TONE: Record<string, string> = {
  watch: "good", label_only: "review", not_watch: "neutral", not_found: "unknown", invalid_input: "error",
  error: "error", not_processed: "unknown",
};
const STATUS_HEADINGS: Record<string, string> = {
  watch: "Watch: qualifying label and at least one recent signal",
  label_only: "Label only: qualifying label, no recent dated signal",
  not_watch: "Not on the watchlist",
  not_found: "No AI adoption data",
  invalid_input: "Invalid input",
  error: "Errors",
  not_processed: "Not processed",
};
const COMPANY_ID = /^[A-Za-z0-9_.-]{1,100}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

// ----- configuration and input -----------------------------------------------------------------

function whole(rawCfg: Json, key: string, def: number, lo: number, hi: number): number {
  const v = rawCfg[key] ?? def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new ConfigError(`${key} must be a whole number from ${lo} to ${hi}.`);
  }
  return v;
}

function textList(value: unknown, key: string, message: string): string[] {
  if (!Array.isArray(value) || !value.length || !value.every((x) => typeof x === "string" && x.trim())) {
    throw new ConfigError(message);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of value as string[]) {
    if (seen.has(x.trim().toUpperCase())) throw new ConfigError(`${key} repeats ${x.trim()}.`);
    seen.add(x.trim().toUpperCase());
    out.push(x.trim());
  }
  return out;
}

export function loadConfig(rawCfg: Json): Json {
  const unknown = Object.keys(rawCfg).filter((k) => !TOP_KEYS.has(k)).sort();
  if (unknown.length) throw new ConfigError(`Unknown configuration key(s): ${unknown.join(", ")}`);
  const labels = textList(rawCfg.labels ?? ["EXPANDING"], "labels",
    "labels must be a non-empty list of non-empty text values.");
  const kindsRaw = rawCfg.signal_kinds ?? null;
  const kinds = kindsRaw === null ? null : textList(kindsRaw, "signal_kinds",
    "signal_kinds must be a non-empty list of non-empty text values, or left out.");
  if (rawCfg.evaluation_date === undefined || rawCfg.evaluation_date === null || rawCfg.evaluation_date === "") {
    throw new ConfigError("evaluation_date is required, as YYYY-MM-DD.");
  }
  const evaluation = parseDate(rawCfg.evaluation_date, "evaluation_date");
  return {
    labels, signal_kinds: kinds,
    recent_days: whole(rawCfg, "recent_days", 90, 1, 3650),
    evaluation_date: evaluation,
    batch_size: whole(rawCfg, "batch_size", 100, 1, 100),
  };
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

// ----- watch rule ------------------------------------------------------------------------------

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Days since 1970-01-01 for the date at the start of `latest` (YYYY-MM-DD, optionally with a time), or null. */
export function signalDay(latest: unknown): number | null {
  if (typeof latest !== "string") return null;
  const m = DATE.exec(latest.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (y < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

export function assess(company: Json, cfg: Json): Json {
  const evaluation = signalDay(cfg.evaluation_date)!;
  const labels = new Set((cfg.labels as string[]).map((x) => x.toUpperCase()));
  const kinds = cfg.signal_kinds === null ? null : new Set((cfg.signal_kinds as string[]).map((x) => x.toUpperCase()));
  const momentum = isObj(company.momentum) ? company.momentum : {};
  const label = momentum.label ?? null;
  const labelText = text(label);
  const labelQualifies = !!labelText && labels.has(labelText.toUpperCase());
  const signals: Json[] = [];
  for (const sig of Array.isArray(momentum.signals) ? momentum.signals : []) {
    if (!isObj(sig)) continue;
    const kind = text(sig.kind);
    const selected = kinds === null || (kind !== null && kinds.has(kind.toUpperCase()));
    const day = signalDay(sig.latest);
    const days = day === null ? null : evaluation - day;
    let recency: string;
    if (days === null) recency = "undated";
    else if (days < 0) recency = "after_evaluation_date";
    else if (days <= cfg.recent_days) recency = "recent";
    else recency = "older";
    signals.push({ kind: sig.kind ?? null, count: sig.count ?? null, latest: sig.latest ?? null,
      kind_selected: selected, days_before_evaluation: days, recency });
  }
  const recent = signals.filter((x) => x.kind_selected && x.recency === "recent");
  const notes: string[] = [];
  const undated = signals.filter((x) => x.kind_selected && x.recency === "undated").length;
  const after = signals.filter((x) => x.kind_selected && x.recency === "after_evaluation_date").length;
  const unselected = signals.filter((x) => !x.kind_selected).length;
  if (undated) notes.push(`${undated} selected signal(s) have no usable latest date. They are not counted as recent.`);
  if (after) notes.push(`${after} selected signal(s) are dated after the evaluation date. They are not counted as recent.`);
  if (unselected) notes.push(`${unselected} signal(s) are of a kind not in signal_kinds. They are shown but not counted.`);
  const window = `within ${cfg.recent_days} days before ${cfg.evaluation_date}`;
  let latestRecent: string | null = null;
  for (const x of recent) {
    const v = String(x.latest);
    if (latestRecent === null || v > latestRecent) latestRecent = v;
  }
  let status: string;
  let reason: string;
  if (labelQualifies && recent.length) {
    status = "watch";
    reason = `Momentum label ${labelText} is a configured label, and ${recent.length} selected signal(s) are ` +
      `dated ${window}. The latest is ${latestRecent}.`;
  } else if (labelQualifies) {
    status = "label_only";
    reason = `Momentum label ${labelText} is a configured label, but no selected signal is dated ${window}.`;
  } else if (labelText === null) {
    status = "not_watch";
    reason = "AI Adoption returned no momentum label, so the watch rule is not met. This is not a finding of " +
      "no momentum.";
  } else {
    status = "not_watch";
    reason = `Momentum label ${labelText} is not one of the configured labels.`;
  }
  return {
    status, status_reason: reason,
    momentum: { label, label_qualifies: labelQualifies, signals },
    recent_signal_count: recent.length, latest_recent_signal: latestRecent, notes,
  };
}

// ----- run -------------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<{ rows: Json[]; summary: Json; coverage: string[] }> {
  const cfg = ctx.config;
  const kindsText = cfg.signal_kinds ? cfg.signal_kinds.join(", ") : "every kind";
  const coverage = [
    "Accounts come from your input file. The REST API has no company search and no list of companies by " +
      "momentum.",
    "Momentum labels and signals are shown as returned by the API. This code computes no score and no trend.",
    "AI momentum does not prove buying intent. A watch status means the configured rule matched, nothing more.",
    `The watch rule: the momentum label is one of ${cfg.labels.join(", ")} (ignoring case), and at least one ` +
      `signal of ${kindsText} has a latest date within ${cfg.recent_days} days before ${cfg.evaluation_date}.`,
    "Recency uses each signal's latest date only. The API does not give earlier dates for a signal.",
    "An account with no AI adoption data is reported as not_found. It is not counted as having no momentum.",
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
    const base: Json = { row_id: row.row_id, input: row, subject, duplicate_of: null, company: null, momentum: null,
      recent_signal_count: null, latest_recent_signal: null, notes: [] };
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
        status_reason: "Firmable holds no AI adoption data for this account, or could not match it. " +
          "It is not counted as having no momentum." };
    }
    const c = value.company;
    base.company = { firmable_id: c.firmable_id ?? null, company_name: c.company_name ?? null,
      overall_level: c.overall_level ?? null, as_of: c.as_of ?? null, framework_version: c.framework_version ?? null };
    return { ...base, ...assess(c, cfg) };
  };

  const rows = await ctx.runRows(ctx.rows, one);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const unique = rows.filter((r) => !r.duplicate_of);
  const found = unique.filter((r) => ["watch", "label_only", "not_watch"].includes(r.status));
  const labelCounts: Record<string, number> = {};
  for (const r of found) {
    const lb = text((r.momentum ?? {}).label) ?? "not returned";
    labelCounts[lb] = (labelCounts[lb] ?? 0) + 1;
  }
  const summary = {
    rows_in_input: rows.length, unique_accounts_asked: keys.length, status_counts: counts,
    accounts_with_data: found.length,
    watch_among_accounts_with_data: found.filter((r) => r.status === "watch").length,
    label_only_among_accounts_with_data: found.filter((r) => r.status === "label_only").length,
    not_watch_among_accounts_with_data: found.filter((r) => r.status === "not_watch").length,
    momentum_label_counts: labelCounts,
  };
  if (dupes) coverage.push(`${dupes} row(s) repeat an earlier account; the earlier answer was reused, not requested again.`);
  return { rows, summary, coverage };
}

// ----- CSV and report --------------------------------------------------------------------------

export const CSV_COLUMNS = ["row_id", "asked_by", "asked_value", "company_name", "segment", "duplicate_of", "status",
  "status_reason", "momentum_label", "recent_signals", "latest_recent_signal", "all_signals",
  "overall_level", "as_of", "firmable_id"];

const sigText = (x: Json): string => `${s(x.kind)}: ${s(x.count)}, latest ${s(x.latest) || "not returned"}`;

export function csvRows(result: Json): Record<string, unknown>[] {
  return result.rows.map((r: Json) => {
    const company = r.company ?? {};
    const subject = r.subject ?? {};
    const signals: Json[] = (r.momentum ?? {}).signals ?? [];
    return {
      row_id: r.row_id, asked_by: subject.type,
      asked_value: subject.value || r.input.company_id || r.input.domain,
      company_name: company.company_name || r.input.company_name,
      segment: r.input.segment, duplicate_of: r.duplicate_of, status: r.status,
      status_reason: r.status_reason || r.reason,
      momentum_label: (r.momentum ?? {}).label,
      recent_signals: signals.filter((x) => x.kind_selected && x.recency === "recent").map(sigText),
      latest_recent_signal: r.latest_recent_signal,
      all_signals: signals.map(sigText),
      overall_level: company.overall_level, as_of: company.as_of, firmable_id: company.firmable_id,
    };
  });
}

export function render(report: Report, result: Json): void {
  const sm = result.summary;
  const counts: Record<string, number> = sm.status_counts ?? {};
  let body = "<p>" + STATUS_ORDER.filter((k) => k in counts)
    .map((k) => badge(`${k.replace(/_/g, " ")}: ${counts[k]}`, STATUS_TONE[k] ?? "neutral")).join(" ") + "</p>";
  const withData = `${sm.accounts_with_data} accounts with AI adoption data`;
  body += table(["Measure", "Count", "Out of"], [
    ["Accounts on the watchlist", sm.watch_among_accounts_with_data, withData],
    ["Qualifying label, no recent signal", sm.label_only_among_accounts_with_data, withData],
    ["Not on the watchlist", sm.not_watch_among_accounts_with_data, withData],
    ["Accounts with AI adoption data", sm.accounts_with_data, `${sm.unique_accounts_asked} unique accounts asked`],
  ]);
  body += note("AI momentum does not prove buying intent. Counts describe the accounts in your file only.", "unknown");
  report.add("Result", "Watchlist summary", body);
  for (const status of STATUS_ORDER) {
    const rows = result.rows.filter((r: Json) => r.status === status);
    if (!rows.length) continue;
    const trs = rows.map((r: Json) => {
      const company = r.company ?? {};
      const subject = r.subject ?? {};
      const signals: Json[] = (r.momentum ?? {}).signals ?? [];
      const sigHtml = signals.map((x) => esc(`${sigText(x)} (${x.recency.replace(/_/g, " ")}` +
        (x.kind_selected ? "" : ", kind not selected") + ")")).join("<br>") || "none returned";
      return [r.row_id, company.company_name || r.input.company_name || subject.value || r.input.domain || r.input.company_id,
        (r.momentum ?? {}).label, raw(sigHtml), [r.status_reason || r.reason || "", ...(r.notes ?? [])].join(" ")];
    });
    report.add("Accounts", STATUS_HEADINGS[status], table(["Row", "Account", "Momentum label", "Signals as returned", "Why"], trs));
  }
}

export const RECIPE: Recipe = {
  name: NAME, title: TITLE, description: DESCRIPTION, loadConfig, readInput, plan, run,
  csvColumns: CSV_COLUMNS, csvRows, render,
};
