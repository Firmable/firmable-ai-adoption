import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, InputError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, md, plan } from "../src/recipe.js";

const F = fixturesDir("peer-comparison");
const tmp = () => mkdtempSync(join(tmpdir(), "pc-"));

function run(name: string, o: { config?: string; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: o.config ?? (existsSync(own) ? own : join(F, "config.json")),
    scenario: join(F, `${name}.scenario.json`), maxCredits: 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));
const comparison = (result: Json, m: string): Json => result.summary.comparisons.find((c: Json) => c.measure === m);

test("happy path statuses and one batch", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.equal(rows.f.status, "found");
  assert.equal(rows.p3.role, "peer");
  assert.equal(rows.p4.status, "not_found");
  assert.equal(rows.p6.duplicate_of, "p1");
  assert.equal(rows.p7.status, "invalid_input");
  assert.equal(rows.p8.status, "excluded");
  assert.equal(rows.p9.status, "excluded");
  assert.equal(transport.sent.length, 1);
  assert.equal((transport.sent[0].jsonBody as Json).records.length, 7);
  assert.deepEqual(transport.unused(), []);
});

test("placement states its denominator", async () => {
  const [result] = await run("happy");
  const overall = comparison(result, "overall_level");
  assert.equal(overall.placement, "Same level as 2 of 4 peers with data.");
  assert.equal(overall.peers_no_value, 1);
  const hiring = comparison(result, "hiring");
  assert.equal(hiring.peers_with_value, 3);
  assert.equal(hiring.peers_no_value, 2);
  assert.deepEqual(comparison(result, "workforce").distribution.map((d: Json) => d.value), ["BASIC", "STRONG", "EMERGING"]);
  assert.equal(comparison(result, "momentum").placement, "Same momentum label as 3 of 4 peers with data.");
});

test("peer cohort is described from the input", async () => {
  const [result] = await run("happy");
  const pc = result.summary.peer_cohort;
  assert.deepEqual([pc.peer_rows, pc.companies, pc.found, pc.not_found, pc.invalid_input], [9, 6, 4, 1, 1]);
  assert.equal(pc.excluded_as_focus, 2);
  assert.deepEqual(pc.segments.map((s: Json) => s.segment), ["Listed", "Private", "(blank)"]);
});

test("markdown escapes API text and HTML is escaped", async () => {
  const out = tmp();
  await run("happy", { out });
  const text = readFileSync(join(out, "peer-comparison.md"), "utf-8");
  assert.ok(text.includes("\\# Synthetic \\[link\\](javascript:alert(1)) \\<b\\>bold\\</b\\> \\| pipe\\_and \\*stars\\*"));
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>Peer</b>") && html.includes("&lt;b&gt;Peer&lt;/b&gt;"));
});

test("md helper", () => {
  assert.equal(md(null), "not returned");
  assert.equal(md("# a|b_c"), "\\# a\\|b\\_c");
  assert.equal(md("line\nbreak"), "line break");
});

test("focus not found is not placed", async () => {
  const [result] = await run("focus-not-found");
  const overall = comparison(result, "overall_level");
  assert.equal(overall.focus_value, null);
  assert.equal(overall.placement, "The focus company has no value for this measure, so it is not placed.");
  assert.equal(overall.too_few_answers, true);
});

test("too few answers when the focus is found", async () => {
  const d = tmp();
  writeFileSync(join(d, "c.json"), JSON.stringify({ min_answered: 5 }));
  const [result] = await run("happy", { config: join(d, "c.json") });
  assert.equal(comparison(result, "overall_level").placement, "Too few answers to compare: 4 peer(s) with a value, fewer than 5.");
});

test("errors and 402 stop", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.f.error.status, 503);
  assert.equal(rows.p4.error.kind, "insufficient_credits");
  assert.equal(rows.p6.status, "not_processed");
  assert.equal(transport.sent.length, 3);
  assert.equal(result.summary.peers_without_answer.length, 4);
});

test("evidence query and truncation", async () => {
  const [result, transport] = await run("evidence");
  assert.deepEqual(transport.sent[0].query, { withEvidence: "true" });
  assert.equal(result.summary.focus.evidence_summary.hiring.truncated, true);
});

const badInputs: [string, string][] = [
  ["role,domain\npeer,a.example\npeer,b.example\n", "exactly one row must have role focus; found 0"],
  ["role,domain\nfocus,a.example\nfocus,b.example\n", "found 2"],
  ["role,domain\nfocus,a.example\nrival,b.example\n", "role must be focus or peer, not 'rival'"],
  ["domain\na.example\n", "missing column(s): role"],
];
for (const [text, message] of badInputs) {
  test(`invalid input: ${message}`, () => {
    const d = tmp();
    writeFileSync(join(d, "in.csv"), text);
    assert.throws(() => RECIPE.readInput(join(d, "in.csv")), (e: Error) => e instanceof InputError && e.message.includes(message));
  });
}

const bad: [(c: Json) => void, string][] = [
  [(c) => { c.min_answered = 0; }, "min_answered must be a whole number"],
  [(c) => { c.with_evidence = 1; }, "with_evidence must be true or false"],
  [(c) => { c.batch_size = 500; }, "batch_size must be a whole number from 1 to 100"],
  [(c) => { c.group_by = "segment"; }, "Unknown configuration key"],
];
for (const [mutate, message] of bad) {
  test(`invalid config: ${message}`, () => {
    const cfg = JSON.parse(readFileSync(join(F, "config.json"), "utf-8"));
    mutate(cfg);
    assert.throws(() => loadConfig(cfg), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("plan counts unique valid companies", () => {
  const cfg = loadConfig(JSON.parse(readFileSync(join(F, "config.json"), "utf-8")));
  const [call] = plan(RECIPE.readInput(join(F, "happy.input.csv")), cfg);
  assert.equal(call.requests, 1);
  assert.equal(call.toDict().published_estimate_upper_bound, 1.4);
});

test("CLI plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 1.4);
});

test("CLI live needs a limit and a key", async () => {
  const out = tmp();
  const args = ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out];
  assert.equal(await cliMain(RECIPE, [...args, "--live"]), 2);
  delete process.env.FIRMABLE_API_KEY;
  assert.equal(await cliMain(RECIPE, [...args, "--live", "--max-credits", "5"]), 2);
});

test("CLI rejects input without a focus", async () => {
  const d = tmp();
  writeFileSync(join(d, "in.csv"), "role,domain\npeer,a.example\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});
