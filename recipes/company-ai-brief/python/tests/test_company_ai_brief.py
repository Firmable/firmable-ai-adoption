import csv
import json

import pytest

from company_ai_brief.recipe import RECIPE, load_config, md, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError, InputError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("company-ai-brief")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def areas(row):
    return {a["area"]: a for a in row["ai_adoption"]["areas"]}


def test_happy_path_statuses_and_one_batch():
    result, transport = run("happy")
    rows = by_id(result)
    assert [rows[k]["status"] for k in ["c1", "c2", "c3", "c4", "c5", "c6/x", "c7", "c8"]] == [
        "brief_ready", "not_found", "brief_ready", "brief_ready", "invalid_input", "brief_ready", "invalid_input", "error"]
    assert rows["c4"]["duplicate_of"] == "c1" and rows["c4"]["brief_file"] == "ai-brief-c1.md"
    assert transport.unused() == []
    assert len(transport.sent) == 1
    assert transport.sent[0].query == {"withEvidence": "true"}
    assert transport.sent[0].json_body["records"][1] == {"company_id": "f900000000002", "external_id": "c2"}
    assert result["summary"]["unique_companies_asked"] == 5


def test_levels_and_momentum_are_shown_as_returned():
    result, _ = run("happy")
    ai = by_id(result)["c1"]["ai_adoption"]
    assert ai["overall_level"] == "STRONG"
    assert ai["explanation"] == "AI workforce strong, meaningful architecture, basic AI hiring."
    assert ai["momentum"] == {"label": "EXPANDING", "signals": [{"kind": "AI hiring", "count": 2, "latest": "2026-10-13"}]}
    assert list(areas(by_id(result)["c1"])) == ["architecture", "footprint", "hiring", "initiatives", "workforce"]
    assert "score" not in json.dumps(ai).lower()


def test_evidence_split_truncation_limit_and_gaps():
    result, _ = run("happy")
    a = areas(by_id(result)["c1"])
    arch = a["architecture"]["evidence"]
    assert [i["technology"] for i in arch["qualifying"]] == ["Model Server Example"]
    assert [i["technology"] for i in arch["not_qualifying"]] == ["Old Queue Example"]
    assert a["architecture"]["flags"] == ["Evidence is truncated: 2 of 33 item(s) were returned."]
    hiring = a["hiring"]["evidence"]
    assert hiring["qualifying_count"] == 2 and len(hiring["qualifying"]) == 1 and hiring["not_shown"] == 1
    assert a["footprint"]["evidence"]["unstated_count"] == 1
    assert a["initiatives"]["flags"] == ["Firmable holds 5 evidence item(s) for this area, but none were returned."]


def test_workforce_item_from_another_organisation_is_flagged_not_removed():
    result, _ = run("happy")
    wf = areas(by_id(result)["c1"])["workforce"]["evidence"]
    assert wf["other_organisation_items"] == [
        {"ref": {"type": "person", "id": "fp900000000002"},
         "fields": [{"field": "company_name", "value": "Other Org Example"}]}]
    assert wf["qualifying_count"] == 2


def test_unknown_level_missing_area_and_conflicting_name():
    result, _ = run("happy")
    g = by_id(result)["c3"]
    a = areas(g)
    assert a["architecture"]["level"] == "EXEMPLARY" and a["architecture"]["level_documented"] is False
    assert g["ai_adoption"]["overall_level_documented"] is False
    assert a["workforce"]["flags"] == ["The API returned no data for this area."]
    assert g["data_notes"] == ["The input names the company \"Gamma Pty\"; AI Adoption names it "
                               "\"Gamma Holdings Example\". Both are shown as given."]
    assert g["ai_adoption"]["momentum"] == {"label": None, "signals": []}


def test_not_found_and_row_error_are_distinct():
    result, _ = run("happy")
    rows = by_id(result)
    assert rows["c2"]["status_reason"].endswith("This is not a finding of no AI adoption.")
    assert rows["c8"]["error"]["code"] == "internal_error"
    assert [e["row_id"] for e in result["errors"]] == ["c8"]


def test_markdown_briefs(tmp_path):
    run("happy", out=tmp_path)
    names = sorted(p.name for p in tmp_path.glob("*.md"))
    assert names == ["ai-brief-c1.md", "ai-brief-c2.md", "ai-brief-c3.md", "ai-brief-c6_x.md"]
    c1 = (tmp_path / "ai-brief-c1.md").read_text()
    assert "Assistant Example \\| Pro" in c1 and "Assistant\\_Trial \\*Example\\*" in c1
    assert "## Not observed" in c1 and "- initiatives: no evidence was returned." in c1
    delta = (tmp_path / "ai-brief-c6_x.md").read_text()
    assert "<script>" not in delta and "\\<script\\>" in delta and "Second line." in delta
    assert "not a finding of no AI adoption" in (tmp_path / "ai-brief-c2.md").read_text()


def test_md_escape():
    assert md("# a_b|c") == "\\# a\\_b\\|c"
    assert md("x\ny") == "x y"


def test_batches_and_external_id_mismatch():
    result, transport = run("batches")
    rows = by_id(result)
    assert len(transport.sent) == 3 and all(r.query == {} for r in transport.sent)
    assert rows["b4"]["status"] == "error" and rows["b4"]["error"]["code"] == "external_id_mismatch"
    assert rows["b3"]["status"] == "brief_ready" and rows["b5"]["status"] == "brief_ready"
    assert all(a["evidence"] == {"status": "not_requested"} for a in rows["b1"]["ai_adoption"]["areas"])


def test_errors_are_kept_and_402_stops_the_run():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["error"]["status"] == 500
    assert rows["e2"]["error"]["kind"] == "invalid_response"
    assert rows["e3"]["error"]["kind"] == "timeout"
    assert rows["e4"]["status"] == "brief_ready"
    assert rows["e5"]["error"]["kind"] == "insufficient_credits"
    assert rows["e6"]["status"] == "not_processed"
    assert result["credits"]["requests_with_uncertain_charge"] == 3
    assert result["coverage"][0].startswith("The run stopped early")
    assert len(transport.sent) == 5


def test_budget_stops_before_the_second_batch():
    result, transport = run("budget", max_credits=7)
    rows = by_id(result)
    assert rows["row-1"]["status"] == "brief_ready" and rows["row-2"]["status"] == "not_found"
    assert rows["row-3"]["error"]["kind"] == "budget_exceeded"
    assert rows["row-4"]["status"] == "not_processed"
    assert len(transport.sent) == 1


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<script>alert" not in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == ["c1", "c2", "c3", "c4", "c5", "c6/x", "c7", "c8"]
    assert "fbl_dev_" not in (tmp_path / "results.json").read_text()


def test_plan_counts_unique_valid_companies_and_batches():
    cfg = load_config({"batch_size": 2})
    rows = RECIPE.read_input(F / "happy.input.csv")
    (call,) = plan(rows, cfg)
    assert call.requests == 3
    assert call.to_dict()["published_estimate_upper_bound"] == 15.0


def test_more_than_25_rows_is_rejected(tmp_path):
    p = tmp_path / "in.csv"
    p.write_text("domain\n" + "".join(f"c{i}.example\n" for i in range(26)))
    with pytest.raises(InputError, match="1 to 25 companies"):
        RECIPE.read_input(p)


@pytest.mark.parametrize("raw,message", [
    ({"colour": "orange"}, "Unknown configuration key"),
    ({"with_evidence": "yes"}, "with_evidence must be true or false"),
    ({"max_items_per_area": -1}, "max_items_per_area must be a whole number from 0 to 100"),
    ({"max_items_per_area": True}, "max_items_per_area must be a whole number"),
    ({"batch_size": 0}, "batch_size must be a whole number from 1 to 100"),
    ({"batch_size": 101}, "batch_size must be a whole number from 1 to 100"),
])
def test_invalid_config(raw, message):
    with pytest.raises(ConfigError, match=message):
        load_config(raw)


def test_cli_plan_mode_makes_no_calls(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    code = cli_main(RECIPE, ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"),
                             "--out", str(tmp_path)])
    assert code == 0
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 15.0
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
