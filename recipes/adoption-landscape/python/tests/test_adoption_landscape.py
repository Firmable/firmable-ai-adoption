import csv
import json
import re

import pytest

from adoption_landscape.recipe import EXPLORER_JS, RECIPE, load_config, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("adoption-landscape")


def run(name, config=None, max_credits=100.0, out=None):
    cfg = config or (F / f"{name}.config.json" if (F / f"{name}.config.json").exists() else F / "config.json")
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv", config_path=cfg,
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def values(dist):
    return {v["value"]: v["count"] for v in dist["values"]}


def test_happy_path_statuses_and_batches():
    result, transport = run("happy")
    rows = by_id(result)
    assert [rows[k]["status"] for k in ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"]] == [
        "found", "found", "not_found", "found", "found", "invalid_input", "found", "found", "found"]
    assert rows["r5"]["duplicate_of"] == "r1"
    assert rows["r9"]["same_company_as"] == "r1"
    assert rows["r2"]["subject"] == "beta.example"
    assert transport.unused() == []
    sizes = [len(r.json_body["records"]) for r in transport.sent]
    assert sizes == [3, 3, 1]
    assert transport.sent[1].json_body["records"][0] == {"company_id": "f900000000004", "external_id": "r4"}


def test_cohort_counts_each_company_once_with_denominators():
    result, _ = run("happy")
    c = result["summary"]["cohort"]
    assert (c["companies"], c["asked"], c["found"], c["not_found"], c["invalid_input"]) == (7, 6, 5, 1, 1)
    d = c["overall_level"]
    assert d["answered"] == 5 and d["no_value"] == 1 and d["no_value_share_pct"] == 16.7
    assert values(d) == {"NONE": 1, "BASIC": 1, "MEANINGFUL": 1, "STRONG": 1, "TRANSFORMING": 1}
    assert d["values"][-1]["value"] == "TRANSFORMING" and d["values"][-1]["share_pct"] == 20.0
    # An area with no level returned is no value, not no adoption.
    init = c["dimensions"]["initiatives"]["level"]
    assert init["answered"] == 4 and init["no_value"] == 2
    assert values(c["dimensions"]["hiring"]["observability"]) == {"LOW": 1, "HIGH": 4}


def test_groups_and_too_few_answers():
    result, _ = run("happy")
    groups = {g["group"]: g for g in result["summary"]["groups"]}
    assert list(groups) == ["Enterprise", "Growth", "(blank)"]
    assert groups["Enterprise"]["companies"] == 2       # r1, r5 and r9 are one company
    assert groups["Growth"]["not_found"] == 1 and groups["Growth"]["invalid_input"] == 1
    blank = groups["(blank)"]["overall_level"]
    assert blank["too_few_answers"] is True and blank["values"][0]["share_pct"] is None


def test_coverage_flags_known_issues():
    result, _ = run("happy")
    cov = " ".join(result["coverage"])
    assert "this cohort only" in cov
    assert "level(s) the docs do not list: EMERGING, TRANSFORMING" in cov
    assert "more than one framework version: 2026.09, 2026.10" in cov
    assert "1 row(s) resolve to the same Firmable company" in cov
    assert "not that the company has no AI adoption" in cov


def test_groups_from_response_field():
    result, _ = run("group-response")
    groups = [(g["group"], g["companies"]) for g in result["summary"]["groups"]]
    assert groups == [("Financial services", 1), ("Software", 1), ("(not returned)", 2)]


def test_missing_group_column_is_reported(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"batch_size": 3, "group_by": "region", "min_answered": 2}))
    result, _ = run("happy", config=cfg)
    assert [g["group"] for g in result["summary"]["groups"]] == ["(blank)"]
    assert any("no column region" in c for c in result["coverage"])


def test_errors_are_kept_per_company_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e0"]["status"] == "found"
    assert rows["e1"]["error"]["status"] == 500 and rows["e1"]["error"]["charge_uncertain"] is True
    assert rows["e2"]["error"]["kind"] == "answer_error" and rows["e2"]["error"]["code"] == "scoring_failed"
    assert rows["e3"]["error"]["kind"] == "invalid_response"
    assert "0 result(s) for 1 company(ies)" in rows["e4"]["error"]["message"]
    assert "external_id zzz" in rows["e5"]["error"]["message"]
    assert rows["e6"]["error"]["kind"] == "timeout"
    assert rows["e7"]["error"]["kind"] == "insufficient_credits"
    assert rows["e8"]["status"] == "not_processed"
    assert len(transport.sent) == 8
    assert result["credits"]["requests_with_uncertain_charge"] == 4
    assert result["coverage"][0].startswith("The run stopped early")
    assert result["summary"]["cohort"]["error"] == 7


def test_budget_stops_before_the_next_batch():
    result, transport = run("budget", max_credits=1.5)
    assert [r["status"] for r in result["rows"]] == ["found", "found", "error", "error", "not_processed"]
    assert result["errors"][0]["kind"] == "budget_exceeded"
    assert len(transport.sent) == 1


def test_evidence_is_summarised_and_truncation_shown():
    result, transport = run("evidence")
    assert transport.sent[0].query == {"withEvidence": "true"}
    ev = result["rows"][0]["evidence_summary"]["hiring"]
    assert ev == {"item_count": 5, "items_returned": 2, "qualifying": 1, "not_qualifying": 1, "truncated": True,
                  "as_of": "2026-11-05"}
    assert result["rows"][1]["evidence_summary"] == {}
    assert result["summary"]["cohort"]["overall_level"]["too_few_answers"] is True   # default min_answered 5
    assert any("truncated" in c for c in result["coverage"])


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>Eps</b>" not in html and "&lt;b&gt;Eps&lt;/b&gt;" in html
    assert "<script>alert" not in html
    js = EXPLORER_JS.read_text()
    assert js in html and "script-src 'sha256-" in html
    assert 'id="explorer-data"' in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == [f"r{i}" for i in range(1, 10)]
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_explorer_script_uses_no_html_sinks():
    js = EXPLORER_JS.read_text()
    for sink in ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "Function(", "fetch(",
                 "XMLHttpRequest", "setAttribute(\"on", "import("]:
        assert sink not in js, sink
    assert re.search(r"JSON\.parse\(src\.textContent\)", js)


def test_plan_counts_unique_valid_companies_and_batches():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    rows = RECIPE.read_input(F / "happy.input.csv")
    [call] = plan(rows, cfg)
    assert call.requests == 3                         # 7 unique valid companies in batches of 3
    assert call.to_dict()["published_estimate_upper_bound"] == 1.4


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(batch_size=0), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(batch_size=101), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(with_evidence="yes"), "with_evidence must be true or false"),
    (lambda c: c.update(group_by=""), "group_by must be null"),
    (lambda c: c.update(min_answered=0), "min_answered must be a whole number"),
    (lambda c: c.update(colour="orange"), "Unknown configuration key"),
])
def test_invalid_config(mutate, message):
    cfg = json.loads((F / "config.json").read_text())
    mutate(cfg)
    with pytest.raises(ConfigError, match=message):
        load_config(cfg)


def test_defaults():
    assert load_config({}) == {"batch_size": 100, "with_evidence": False, "group_by": None, "min_answered": 5}


def test_cli_plan_mode_makes_no_calls(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    code = cli_main(RECIPE, ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"),
                             "--out", str(tmp_path)])
    assert code == 0
    plan_json = json.loads((tmp_path / "plan.json").read_text())
    assert plan_json["published_estimate_upper_bound"] == 1.4
    assert plan_json["requests_upper_bound"] == 3
    assert "no API calls were made" in capsys.readouterr().out


def test_cli_live_needs_limit_and_key(tmp_path, monkeypatch):
    args = ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"), "--out", str(tmp_path)]
    assert cli_main(RECIPE, args + ["--live"]) == 2
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    assert cli_main(RECIPE, args + ["--live", "--max-credits", "5"]) == 2


def test_cli_rejects_bad_input(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("name\nAcme\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
