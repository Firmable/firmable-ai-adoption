import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, InputError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, md, plan } from "../src/recipe.js";

const F = fixturesDir("company-ai-brief");
const tmp = () => mkdtempSync(join(tmpdir(), "cab-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(own) ? own : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const areas = (row: Json): Record<string, Json> => Object.fromEntries(row.ai_adoption.areas.map((a: Json) => [a.area, a]));

test("happy path statuses and one batch", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(["c1", "c2", "c3", "c4", "c5", "c6/x", "c7", "c8"].map((k) => rows[k].status), [
    "brief_ready", "not_found", "brief_ready", "brief_ready", "invalid_input", "brief_ready", "invalid_input", "error"]);
  assert.equal(rows.c4.duplicate_of, "c1");
  assert.equal(rows.c4.brief_file, "ai-brief-c1.md");
  assert.deepEqual(transport.unused(), []);
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.sent[0].query, { withEvidence: "true" });
  assert.equal(result.summary.unique_companies_asked, 5);
});

test("levels and momentum are shown as returned", async () => {
  const [result] = await run("happy");
  const ai = byId(result).c1.ai_adoption;
  assert.equal(ai.overall_level, "STRONG");
  assert.deepEqual(ai.momentum, { label: "EXPANDING", signals: [{ kind: "AI hiring", count: 2, latest: "2026-10-13" }] });
  assert.deepEqual(Object.keys(areas(byId(result).c1)), ["architecture", "footprint", "hiring", "initiatives", "workforce"]);
  assert.ok(!JSON.stringify(ai).toLowerCase().includes("score"));
});

test("evidence split, truncation, limit and gaps", async () => {
  const [result] = await run("happy");
  const a = areas(byId(result).c1);
  assert.deepEqual(a.architecture.evidence.qualifying.map((i: Json) => i.technology), ["Model Server Example"]);
  assert.deepEqual(a.architecture.flags, ["Evidence is truncated: 2 of 33 item(s) were returned."]);
  assert.equal(a.hiring.evidence.qualifying_count, 2);
  assert.equal(a.hiring.evidence.qualifying.length, 1);
  assert.equal(a.hiring.evidence.not_shown, 1);
  assert.equal(a.footprint.evidence.unstated_count, 1);
  assert.deepEqual(a.initiatives.flags, ["Firmable holds 5 evidence item(s) for this area, but none were returned."]);
});

test("workforce item from another organisation is flagged, not removed", async () => {
  const [result] = await run("happy");
  const wf = areas(byId(result).c1).workforce.evidence;
  assert.deepEqual(wf.other_organisation_items, [
    { ref: { type: "person", id: "fp900000000002" }, fields: [{ field: "company_name", value: "Other Org Example" }] }]);
  assert.equal(wf.qualifying_count, 2);
});

test("unknown level, missing area and conflicting name", async () => {
  const [result] = await run("happy");
  const g = byId(result).c3;
  const a = areas(g);
  assert.equal(a.architecture.level_documented, false);
  assert.deepEqual(a.workforce.flags, ["The API returned no data for this area."]);
  assert.equal(g.data_notes.length, 1);
  assert.deepEqual(g.ai_adoption.momentum, { label: null, signals: [] });
});

test("not found and row error are distinct", async () => {
  const [result] = await run("happy");
  const rows = byId(result);
  assert.ok(rows.c2.status_reason.endsWith("This is not a finding of no AI adoption."));
  assert.equal(rows.c8.error.code, "internal_error");
  assert.deepEqual(result.errors.map((e: Json) => e.row_id), ["c8"]);
});

test("Markdown briefs", async () => {
  const out = tmp();
  await run("happy", { out });
  assert.deepEqual(readdirSync(out).filter((n) => n.endsWith(".md")).sort(),
    ["ai-brief-c1.md", "ai-brief-c2.md", "ai-brief-c3.md", "ai-brief-c6_x.md"]);
  const c1 = readFileSync(join(out, "ai-brief-c1.md"), "utf-8");
  assert.ok(c1.includes("Assistant Example \\| Pro") && c1.includes("Assistant\\_Trial \\*Example\\*"));
  const delta = readFileSync(join(out, "ai-brief-c6_x.md"), "utf-8");
  assert.ok(!delta.includes("<script>") && delta.includes("\\<script\\>"));
});

test("md escape", () => {
  assert.equal(md("# a_b|c"), "\\# a\\_b\\|c");
  assert.equal(md("x\ny"), "x y");
});

test("batches and external_id mismatch", async () => {
  const [result, transport] = await run("batches");
  const rows = byId(result);
  assert.equal(transport.sent.length, 3);
  assert.equal(rows.b4.error.code, "external_id_mismatch");
  assert.equal(rows.b5.status, "brief_ready");
  assert.ok(rows.b1.ai_adoption.areas.every((a: Json) => a.evidence.status === "not_requested"));
});

test("errors are kept and 402 stops the run", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.error.status, 500);
  assert.equal(rows.e2.error.kind, "invalid_response");
  assert.equal(rows.e3.error.kind, "timeout");
  assert.equal(rows.e4.status, "brief_ready");
  assert.equal(rows.e5.error.kind, "insufficient_credits");
  assert.equal(rows.e6.status, "not_processed");
  assert.equal(result.credits.requests_with_uncertain_charge, 3);
  assert.equal(transport.sent.length, 5);
});

test("budget stops before the second batch", async () => {
  const [result, transport] = await run("budget", { maxCredits: 7 });
  const rows = byId(result);
  assert.equal(rows["row-1"].status, "brief_ready");
  assert.equal(rows["row-3"].error.kind, "budget_exceeded");
  assert.equal(rows["row-4"].status, "not_processed");
  assert.equal(transport.sent.length, 1);
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  assert.ok(!readFileSync(join(out, "report.html"), "utf-8").includes("<script>alert"));
  assert.ok(!readFileSync(join(out, "results.json"), "utf-8").includes("fbl_dev_"));
});

test("plan counts unique valid companies and batches", () => {
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const [call] = plan(rows, loadConfig({ batch_size: 2 }));
  assert.equal(call.requests, 3);
  assert.equal(call.toDict().published_estimate_upper_bound, 15);
});

test("more than 25 rows is rejected", () => {
  const d = tmp();
  writeFileSync(join(d, "in.csv"), "domain\n" + Array.from({ length: 26 }, (_, i) => `c${i}.example\n`).join(""));
  assert.throws(() => RECIPE.readInput(join(d, "in.csv")), (e: Error) => e instanceof InputError && e.message.includes("1 to 25 companies"));
});

const bad: [Json, string][] = [
  [{ colour: "orange" }, "Unknown configuration key"],
  [{ with_evidence: "yes" }, "with_evidence must be true or false"],
  [{ max_items_per_area: -1 }, "max_items_per_area must be a whole number from 0 to 100"],
  [{ max_items_per_area: true }, "max_items_per_area must be a whole number"],
  [{ batch_size: 0 }, "batch_size must be a whole number from 1 to 100"],
  [{ batch_size: 101 }, "batch_size must be a whole number from 1 to 100"],
];
for (const [raw, message] of bad) {
  test(`invalid config: ${message} (${JSON.stringify(raw)})`, () => {
    assert.throws(() => loadConfig(raw), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("CLI plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 15);
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
