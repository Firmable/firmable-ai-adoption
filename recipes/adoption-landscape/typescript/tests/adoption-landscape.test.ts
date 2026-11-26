import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { EXPLORER_JS_PATH, RECIPE, loadConfig, plan } from "../src/recipe.js";

const F = fixturesDir("adoption-landscape");
const tmp = () => mkdtempSync(join(tmpdir(), "al-"));

function run(name: string, o: { config?: string; maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: o.config ?? (existsSync(own) ? own : join(F, "config.json")),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const values = (dist: Json): Record<string, number> => Object.fromEntries(dist.values.map((v: Json) => [v.value, v.count]));

test("happy path statuses and batches", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"].map((k) => rows[k].status),
    ["found", "found", "not_found", "found", "found", "invalid_input", "found", "found", "found"]);
  assert.equal(rows.r5.duplicate_of, "r1");
  assert.equal(rows.r9.same_company_as, "r1");
  assert.deepEqual(transport.unused(), []);
  assert.deepEqual(transport.sent.map((r) => (r.jsonBody as Json).records.length), [3, 3, 1]);
  assert.deepEqual((transport.sent[1].jsonBody as Json).records[0], { company_id: "f900000000004", external_id: "r4" });
});

test("cohort counts each company once with denominators", async () => {
  const [result] = await run("happy");
  const c = result.summary.cohort;
  assert.deepEqual([c.companies, c.asked, c.found, c.not_found, c.invalid_input], [7, 6, 5, 1, 1]);
  const d = c.overall_level;
  assert.equal(d.answered, 5);
  assert.equal(d.no_value_share_pct, 16.7);
  assert.deepEqual(values(d), { NONE: 1, BASIC: 1, MEANINGFUL: 1, STRONG: 1, TRANSFORMING: 1 });
  assert.equal(d.values[4].value, "TRANSFORMING");
  assert.equal(c.dimensions.initiatives.level.no_value, 2);
  assert.deepEqual(values(c.dimensions.hiring.observability), { LOW: 1, HIGH: 4 });
});

test("groups and too few answers", async () => {
  const [result] = await run("happy");
  const groups = Object.fromEntries(result.summary.groups.map((g: Json) => [g.group, g]));
  assert.deepEqual(Object.keys(groups), ["Enterprise", "Growth", "(blank)"]);
  assert.equal(groups.Enterprise.companies, 2);
  assert.equal(groups["(blank)"].overall_level.too_few_answers, true);
  assert.equal(groups["(blank)"].overall_level.values[0].share_pct, null);
});

test("coverage flags known issues", async () => {
  const [result] = await run("happy");
  const cov = result.coverage.join(" ");
  assert.ok(cov.includes("level(s) the docs do not list: EMERGING, TRANSFORMING"));
  assert.ok(cov.includes("more than one framework version: 2026.09, 2026.10"));
  assert.ok(cov.includes("this cohort only"));
});

test("groups from a response field", async () => {
  const [result] = await run("group-response");
  assert.deepEqual(result.summary.groups.map((g: Json) => [g.group, g.companies]),
    [["Financial services", 1], ["Software", 1], ["(not returned)", 2]]);
});

test("missing group column is reported", async () => {
  const d = tmp();
  writeFileSync(join(d, "c.json"), JSON.stringify({ batch_size: 3, group_by: "region", min_answered: 2 }));
  const [result] = await run("happy", { config: join(d, "c.json") });
  assert.deepEqual(result.summary.groups.map((g: Json) => g.group), ["(blank)"]);
  assert.ok(result.coverage.some((c: string) => c.includes("no column region")));
});

test("errors are kept per company and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e0.status, "found");
  assert.equal(rows.e1.error.status, 500);
  assert.equal(rows.e2.error.code, "scoring_failed");
  assert.equal(rows.e3.error.kind, "invalid_response");
  assert.ok(rows.e5.error.message.includes("external_id zzz"));
  assert.equal(rows.e6.error.kind, "timeout");
  assert.equal(rows.e7.error.kind, "insufficient_credits");
  assert.equal(rows.e8.status, "not_processed");
  assert.equal(transport.sent.length, 8);
  assert.equal(result.credits.requests_with_uncertain_charge, 4);
});

test("budget stops before the next batch", async () => {
  const [result, transport] = await run("budget", { maxCredits: 1.5 });
  assert.deepEqual(result.rows.map((r: Json) => r.status), ["found", "found", "error", "error", "not_processed"]);
  assert.equal(result.errors[0].kind, "budget_exceeded");
  assert.equal(transport.sent.length, 1);
});

test("evidence is summarised and truncation shown", async () => {
  const [result, transport] = await run("evidence");
  assert.deepEqual(transport.sent[0].query, { withEvidence: "true" });
  assert.equal(result.rows[0].evidence_summary.hiring.truncated, true);
  assert.equal(result.rows[0].evidence_summary.hiring.not_qualifying, 1);
  assert.equal(result.summary.cohort.overall_level.too_few_answers, true);
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Eps</b>") && html.includes("&lt;b&gt;Eps&lt;/b&gt;"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes(readFileSync(EXPLORER_JS_PATH, "utf-8")) && html.includes("script-src 'sha256-"));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("explorer script uses no HTML sinks", () => {
  const js = readFileSync(EXPLORER_JS_PATH, "utf-8");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "Function(", "fetch(",
    "XMLHttpRequest", "import("]) {
    assert.ok(!js.includes(sink), sink);
  }
});

test("plan counts unique valid companies and batches", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const [call] = plan(RECIPE.readInput(join(F, "happy.input.csv")), cfg);
  assert.equal(call.requests, 3);
  assert.equal(call.toDict().published_estimate_upper_bound, 1.4);
});

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.batch_size = 0; }, "batch_size must be a whole number from 1 to 100"],
  [(c) => { c.batch_size = 101; }, "batch_size must be a whole number from 1 to 100"],
  [(c) => { c.with_evidence = "yes"; }, "with_evidence must be true or false"],
  [(c) => { c.group_by = ""; }, "group_by must be null"],
  [(c) => { c.min_answered = 0; }, "min_answered must be a whole number"],
  [(c) => { c.colour = "orange"; }, "Unknown configuration key"],
];
for (const [mutate, message] of bad) {
  test(`invalid config: ${message}`, () => {
    const cfg = JSON.parse(readFileSync(join(F, "config.json"), "utf-8"));
    mutate(cfg);
    assert.throws(() => loadConfig(cfg), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("defaults", () => {
  assert.deepEqual(loadConfig({}), { batch_size: 100, with_evidence: false, group_by: null, min_answered: 5 });
});

test("CLI plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  const p = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.equal(p.published_estimate_upper_bound, 1.4);
  assert.equal(p.requests_upper_bound, 3);
});

test("CLI live needs a limit and a key", async () => {
  const out = tmp();
  const args = ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out];
  assert.equal(await cliMain(RECIPE, [...args, "--live"]), 2);
  delete process.env.FIRMABLE_API_KEY;
  assert.equal(await cliMain(RECIPE, [...args, "--live", "--max-credits", "5"]), 2);
});

test("CLI rejects bad input", async () => {
  const d = tmp();
  writeFileSync(join(d, "in.csv"), "name\nAcme\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});
