import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, main as cliMain, Json } from "firmable-api-client";
import { fixturesDir, runWithFixtures } from "firmable-api-client/testing";
import { RECIPE, loadConfig, plan } from "../src/recipe.js";

const F = fixturesDir("ai-outreach-angles");
const CONFIG = JSON.parse(readFileSync(join(F, "config.json"), "utf-8"));
const tmp = () => mkdtempSync(join(tmpdir(), "oa-"));

function run(name: string, o: { maxCredits?: number; out?: string } = {}) {
  const own = join(F, `${name}.config.json`);
  return runWithFixtures(RECIPE, {
    inputPath: join(F, `${name}.input.csv`), configPath: existsSync(own) ? own : join(F, "config.json"),
    scenario: join(F, `${name}.scenario.json`), maxCredits: o.maxCredits ?? 100, outDir: o.out,
  });
}
const byId = (result: Json): Record<string, Json> => Object.fromEntries(result.rows.map((r: Json) => [r.row_id, r]));

test("statuses in one batch", async () => {
  const [result, transport] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.status])), {
    o1: "angles_found", o2: "not_found", o3: "angles_found", o4: "no_angle", o5: "angles_found",
    o6: "invalid_input", o7: "angles_found", o8: "error" });
  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.unused(), []);
});

test("angles are filled from returned facts and labelled as suggestions", async () => {
  const [result] = await run("happy");
  const a = Object.fromEntries(byId(result).o1.angles.map((x: Json) => [x.id, x]));
  assert.deepEqual(Object.keys(a), ["leadership_push", "hiring_angle", "workforce_angle"]);
  assert.equal(a.leadership_push.kind, "suggested_angle");
  assert.equal(a.leadership_push.text, "Acme Example shows STRONG AI adoption with EXPANDING momentum. Ask who owns the AI roadmap.");
  assert.deepEqual(byId(result).o1.not_matched_angles, ["early_stage"]);
});

test("skipped and not evaluated are listed separately", async () => {
  const [result] = await run("happy");
  const rows = byId(result);
  assert.deepEqual(rows.o3.skipped_angles, [{ id: "hiring_angle", missing: ["headline"] }]);
  assert.deepEqual(rows.o3.not_evaluated_angles, [{ id: "workforce_angle", unknown_fields: ["dimensions.workforce.level"] }]);
  assert.deepEqual(rows.o4.not_evaluated_angles.map((x: Json) => x.id), ["leadership_push", "early_stage"]);
});

test("level matching ignores case and input name is a fallback", async () => {
  const [result] = await run("happy");
  const eps = Object.fromEntries(byId(result).o7.angles.map((x: Json) => [x.id, x]));
  assert.equal(eps.early_stage.text, "Firmable rates Eps *Input* at BASIC overall. Ask where AI is being trialled.");
  assert.equal(eps.early_stage.filled_from[0].source, "input company_name");
});

test("not found gets no angle", async () => {
  const [result] = await run("happy");
  const o2 = byId(result).o2;
  assert.deepEqual(o2.angles, []);
  assert.ok(o2.status_reason.endsWith("This is not a finding of no AI adoption."));
});

test("summary counts state denominators", async () => {
  const [result] = await run("happy");
  assert.equal(result.summary.accounts_with_data, 4);
  assert.deepEqual(result.summary.angle_counts_among_accounts_with_data,
    { leadership_push: 1, hiring_angle: 2, early_stage: 2, workforce_angle: 1 });
});

test("Markdown shows angles beside facts", async () => {
  const out = tmp();
  await run("happy", { out });
  const text = readFileSync(join(out, "outreach-angles.md"), "utf-8");
  assert.equal(text.split("> **Suggested, not a fact**").length - 1, 6);
  assert.ok(text.includes("| Placeholder `{headline}` | \\<b\\>2 roles\\</b\\> \\| latest Oct 2026 # heading |"));
  assert.ok(!text.includes("<b>"));
});

test("errors and 402 stop", async () => {
  const [result, transport] = await run("errors");
  const rows = byId(result);
  assert.equal(rows.e1.error.status, 500);
  assert.equal(rows.e3.error.kind, "insufficient_credits");
  assert.equal(rows.e5.status, "not_processed");
  assert.equal(transport.sent.length, 2);
});

test("budget stops before any request", async () => {
  const [result, transport] = await run("budget", { maxCredits: 1.2 });
  assert.equal(byId(result)["row-1"].error.kind, "budget_exceeded");
  assert.equal(transport.sent.length, 0);
});

test("outputs are safe", async () => {
  const out = tmp();
  await run("happy", { out });
  const html = readFileSync(join(out, "report.html"), "utf-8");
  assert.ok(!html.includes("<b>2 roles") && html.includes('class="template"'));
});

test("plan", () => {
  const rows = RECIPE.readInput(join(F, "happy.input.csv"));
  const [call] = plan(rows, loadConfig({ ...CONFIG, batch_size: 4 }));
  assert.equal(call.requests, 2);
  assert.equal(call.toDict().published_estimate_upper_bound, 1.2);
});

function mut(fn: (c: Json) => void): Json {
  const c = JSON.parse(JSON.stringify(CONFIG));
  fn(c);
  return c;
}

const bad: [Json, string][] = [
  [mut((c) => { delete c.angles; }), "angles must be a list of 1 to 20 angles"],
  [mut((c) => { c.angles = []; }), "angles must be a list of 1 to 20 angles"],
  [mut((c) => { c.angles = Array(6).fill(c.angles).flat(); }), "angles must be a list of 1 to 20 angles"],
  [mut((c) => { c.angles.push({ ...c.angles[0] }); }), "angles[5].id 'leadership_push' is used twice"],
  [mut((c) => { c.angles[0].when = {}; }), "angles[1].when must be an object with at least one"],
  [mut((c) => { c.angles[0].when.industry_in = ["x"]; }), "angles[1].when has unknown key(s): industry_in"],
  [mut((c) => { c.angles[1].when.dimension.name = "culture"; }), "dimension.name must be one of"],
  [mut((c) => { c.angles[1].when.dimension = { name: "hiring" }; }), "must be an object with name and level_in only"],
  [mut((c) => { c.angles[0].when.momentum_in = []; }), "momentum_in must be a non-empty list"],
  [mut((c) => { c.angles[0].template = "{headline} here"; }), "which needs when.dimension"],
  [mut((c) => { c.angles[0].template = "Hi {industry}"; }), "which is not one of"],
  [mut((c) => { c.angles[0].template = "Hi {company_name"; }), "unmatched brace"],
  [mut((c) => { c.angles[0].id = "Bad Id"; }), "angles[1].id must be 1 to 40"],
  [mut((c) => { c.angles[0].tone = "warm"; }), "angles[1] has unknown key(s): tone"],
  [mut((c) => { c.batch_size = 0; }), "batch_size must be a whole number from 1 to 100"],
  [mut((c) => { c.colour = "orange"; }), "Unknown configuration key"],
];
for (const [cfg, message] of bad) {
  test(`invalid config: ${message}`, () => {
    assert.throws(() => loadConfig(cfg), (e: Error) => e instanceof ConfigError && e.message.includes(message));
  });
}

test("CLI plan mode makes no calls", async () => {
  const out = tmp();
  delete process.env.FIRMABLE_API_KEY;
  const code = await cliMain(RECIPE, ["--input", join(F, "happy.input.csv"), "--config", join(F, "config.json"), "--out", out]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).published_estimate_upper_bound, 1.2);
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
