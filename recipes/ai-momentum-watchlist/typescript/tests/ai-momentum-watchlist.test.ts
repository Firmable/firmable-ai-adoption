import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json, parseCsv } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, plan } from "../src/recipe.js";

const F = fixturesDir("ai-momentum-watchlist");
const BASE = { evaluation_date: "2026-11-20" };
const tmp = () => mkdtempSync(join(tmpdir(), "amw-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(own) ? own : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));

test("statuses in one batch without evidence", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.status])), {
    w1: "watch", w2: "label_only", w3: "not_watch", w4: "not_watch", w5: "not_found",
    w6: "watch", w7: "invalid_input", w8: "watch", w9: "error" });
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.sent[0].query, {});
  assert.deepEqual(transport.unused(), []);
  assert.equal(rows.w6.duplicate_of, "w1");
});

test("signals are kept as returned with recency", async () => {
  const [result] = await run("happy");
  assert.deepEqual(byId(result).w1.momentum.signals, [
    { kind: "AI hiring", count: 2, latest: "2026-10-13", kind_selected: true, days_before_evaluation: 38, recency: "recent" },
    { kind: "AI initiatives", count: 1, latest: "2026-03-01", kind_selected: true, days_before_evaluation: 264, recency: "older" }]);
  assert.equal(byId(result).w1.latest_recent_signal, "2026-10-13");
});

test("label only, undated, future and timestamp signals", async () => {
  const [result] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(rows.w2.notes, ["1 selected signal(s) have no usable latest date. They are not counted as recent."]);
  assert.equal(rows.w8.momentum.label_qualifies, true);
  assert.deepEqual(rows.w8.momentum.signals.map((x: Json) => x.recency), ["after_evaluation_date", "recent", "undated"]);
});

test("missing label is not a finding of no momentum", async () => {
  const [result] = await run("happy");
  const rows = byId(result);
  assert.equal(rows.w4.momentum.label, null);
  assert.ok(rows.w4.status_reason.endsWith("This is not a finding of no momentum."));
});

test("summary states denominators", async () => {
  const [result] = await run("happy");
  assert.equal(result.summary.accounts_with_data, 5);
  assert.equal(result.summary.watch_among_accounts_with_data, 2);
  assert.deepEqual(result.summary.momentum_label_counts, { EXPANDING: 2, STEADY: 1, "not returned": 1, accelerating: 1 });
});

test("signal kind filter and batches", async () => {
  const [result, transport] = await run("kinds");
  const rows = byId(result);
  assert.equal(rows.k1.status, "label_only");
  assert.equal(rows.k2.status, "watch");
  assert.equal(rows.k3.status, "not_found");
  assert.equal(transport.sent.length, 2);
});

test("errors and 402 stop", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.error.status, 500);
  assert.equal(rows.e3.error.kind, "invalid_response");
  assert.equal(rows.e5.error.kind, "insufficient_credits");
  assert.equal(rows.e6.status, "not_processed");
  assert.deepEqual(result.errors.map((e: Json) => e.kind), ["server_error", "invalid_response", "insufficient_credits"]);
  assert.equal(transport.sent.length, 3);
});

test("budget stops before the second batch", async () => {
  const [result, transport] = await run("budget", { maxCredits: 1.5 });
  const rows = byId(result);
  assert.equal(rows["row-1"].status, "watch");
  assert.equal(rows["row-3"].error.kind, "budget_exceeded");
  assert.equal(transport.sent.length, 1);
});

test("CSV and report", async () => {
  const out = tmp();
  await run("happy", { out });
  const table = parseCsv(readFileSync(join(out, "results.csv"), "utf-8"));
  const header = table[0];
  const first = Object.fromEntries(header.map((h, i) => [h, table[1][i]]));
  assert.equal(first.recent_signals, "AI hiring: 2, latest 2026-10-13");
  assert.equal(first.segment, "Enterprise");
  assert.ok(readFileSync(join(out, "report.html"), "utf-8").includes("does not prove buying intent"));
});

test("plan counts batches", () => {
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const [call] = plan(rows, loadConfig({ ...BASE, batch_size: 3 }));
  assert.equal(call.requests, 3);
  assert.equal(call.toDict().published_estimate_upper_bound, 1.4);
});

const bad: [Json, string][] = [
  [{}, "evaluation_date is required"],
  [{ evaluation_date: "2026-02-30" }, "evaluation_date must be a date as YYYY-MM-DD"],
  [{ ...BASE, labels: [] }, "labels must be a non-empty list"],
  [{ ...BASE, labels: ["EXPANDING", ""] }, "labels must be a non-empty list"],
  [{ ...BASE, labels: ["EXPANDING", "expanding"] }, "labels repeats expanding"],
  [{ ...BASE, signal_kinds: [] }, "signal_kinds must be a non-empty list"],
  [{ ...BASE, recent_days: 0 }, "recent_days must be a whole number from 1 to 3650"],
  [{ ...BASE, batch_size: 101 }, "batch_size must be a whole number from 1 to 100"],
  [{ ...BASE, colour: "orange" }, "Unknown configuration key"],
];
for (const [rawCfg, message] of bad) {
  test(`invalid config: ${message} (${JSON.stringify(rawCfg)})`, () => {
    assert.throws(() => loadConfig(rawCfg), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("default labels", () => {
  assert.deepEqual(loadConfig(BASE).labels, ["EXPANDING"]);
  assert.equal(loadConfig(BASE).signal_kinds, null);
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

test("CLI rejects bad input", async () => {
  const d = tmp();
  writeFileSync(join(d, "in.csv"), "name\nAcme\n");
  assert.equal(await cliMain(RECIPE, ["--input", join(d, "in.csv"), "--config", join(F, "config.json"), "--out", d]), 2);
});
