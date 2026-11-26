import copy
import csv
import json

import pytest

from ai_outreach_angles.recipe import RECIPE, load_config, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("ai-outreach-angles")
CONFIG = json.loads((F / "config.json").read_text())


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def test_statuses_in_one_batch():
    result, transport = run("happy")
    rows = by_id(result)
    assert {k: r["status"] for k, r in rows.items()} == {
        "o1": "angles_found", "o2": "not_found", "o3": "angles_found", "o4": "no_angle", "o5": "angles_found",
        "o6": "invalid_input", "o7": "angles_found", "o8": "error"}
    assert len(transport.sent) == 1 and transport.sent[0].query == {}
    assert transport.unused() == []
    assert rows["o5"]["duplicate_of"] == "o1"


def test_angles_are_filled_from_returned_facts_and_labelled_as_suggestions():
    result, _ = run("happy")
    a = {x["id"]: x for x in by_id(result)["o1"]["angles"]}
    assert list(a) == ["leadership_push", "hiring_angle", "workforce_angle"]
    lp = a["leadership_push"]
    assert lp["kind"] == "suggested_angle"
    assert lp["text"] == "Acme Example shows STRONG AI adoption with EXPANDING momentum. Ask who owns the AI roadmap."
    assert lp["filled_from"][0] == {"placeholder": "company_name", "value": "Acme Example",
                                    "source": "AI Adoption company_name"}
    assert [c["result"] for c in lp["conditions"]] == ["yes", "yes"]
    assert by_id(result)["o1"]["not_matched_angles"] == ["early_stage"]


def test_skipped_and_not_evaluated_are_listed_separately():
    result, _ = run("happy")
    rows = by_id(result)
    assert rows["o3"]["skipped_angles"] == [{"id": "hiring_angle", "missing": ["headline"]}]
    assert rows["o3"]["not_evaluated_angles"] == [{"id": "workforce_angle",
                                                   "unknown_fields": ["dimensions.workforce.level"]}]
    assert rows["o3"]["not_matched_angles"] == ["leadership_push"]
    assert rows["o4"]["not_evaluated_angles"] == [{"id": "leadership_push", "unknown_fields": ["overall_level"]},
                                                  {"id": "early_stage", "unknown_fields": ["overall_level"]}]
    assert rows["o4"]["angles"] == []


def test_level_matching_ignores_case_and_input_name_is_a_fallback():
    result, _ = run("happy")
    eps = {x["id"]: x for x in by_id(result)["o7"]["angles"]}
    assert eps["early_stage"]["text"] == "Firmable rates Eps *Input* at BASIC overall. Ask where AI is being trialled."
    assert eps["early_stage"]["filled_from"][0]["source"] == "input company_name"


def test_not_found_gets_no_angle():
    result, _ = run("happy")
    o2 = by_id(result)["o2"]
    assert o2["angles"] == [] and o2["status_reason"].endswith("This is not a finding of no AI adoption.")


def test_summary_counts_state_denominators():
    result, _ = run("happy")
    s = result["summary"]
    assert s["accounts_with_data"] == 4
    assert s["angle_counts_among_accounts_with_data"] == {"leadership_push": 1, "hiring_angle": 2, "early_stage": 2,
                                                          "workforce_angle": 1}


def test_markdown_shows_angles_beside_facts(tmp_path):
    run("happy", out=tmp_path)
    text = (tmp_path / "outreach-angles.md").read_text()
    assert text.count("> **Suggested, not a fact**") == 6
    assert "| Placeholder `{headline}` | \\<b\\>2 roles\\</b\\> \\| latest Oct 2026 # heading |" in text
    assert "## Eps \\*Input\\* (row o7)" in text
    assert "No angle: Firmable holds no AI adoption data" in text
    assert "<b>" not in text


def test_errors_and_402_stop():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["error"]["status"] == 500 and rows["e2"]["status"] == "error"
    assert rows["e3"]["error"]["kind"] == "insufficient_credits"
    assert rows["e4"]["status"] == "not_processed" and rows["e5"]["status"] == "not_processed"
    assert len(transport.sent) == 2


def test_budget_stops_before_any_request():
    result, transport = run("budget", max_credits=1.2)
    rows = by_id(result)
    assert rows["row-1"]["error"]["kind"] == "budget_exceeded"
    assert rows["row-2"]["status"] == "not_processed"
    assert transport.sent == []


def test_outputs_are_safe(tmp_path):
    run("happy", out=tmp_path)
    html = (tmp_path / "report.html").read_text()
    assert "<b>2 roles" not in html and 'class="template"' in html
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"]
    assert rows[0]["angle_ids"] == "leadership_push; hiring_angle; workforce_angle"


def test_plan():
    rows = RECIPE.read_input(F / "happy.input.csv")
    (call,) = plan(rows, load_config({**CONFIG, "batch_size": 4}))
    assert call.requests == 2
    assert call.to_dict()["published_estimate_upper_bound"] == 1.2


def _mut(fn):
    cfg = copy.deepcopy(CONFIG)
    fn(cfg)
    return cfg


@pytest.mark.parametrize("cfg,message", [
    (_mut(lambda c: c.pop("angles")), "angles must be a list of 1 to 20 angles"),
    (_mut(lambda c: c.update(angles=[])), "angles must be a list of 1 to 20 angles"),
    (_mut(lambda c: c.update(angles=CONFIG["angles"] * 6)), "angles must be a list of 1 to 20 angles"),
    (_mut(lambda c: c["angles"].append(dict(CONFIG["angles"][0]))), "angles[5].id 'leadership_push' is used twice"),
    (_mut(lambda c: c["angles"][0].update(when={})), "angles[1].when must be an object with at least one"),
    (_mut(lambda c: c["angles"][0]["when"].update(industry_in=["x"])), "angles[1].when has unknown key(s): industry_in"),
    (_mut(lambda c: c["angles"][1]["when"]["dimension"].update(name="culture")), "dimension.name must be one of"),
    (_mut(lambda c: c["angles"][1]["when"].update(dimension={"name": "hiring"})), "must be an object with name and level_in only"),
    (_mut(lambda c: c["angles"][0]["when"].update(momentum_in=[])), "momentum_in must be a non-empty list"),
    (_mut(lambda c: c["angles"][0].update(template="{headline} here")), "which needs when.dimension"),
    (_mut(lambda c: c["angles"][0].update(template="Hi {industry}")), "which is not one of"),
    (_mut(lambda c: c["angles"][0].update(template="Hi {company_name")), "unmatched brace"),
    (_mut(lambda c: c["angles"][0].update(id="Bad Id")), "angles[1].id must be 1 to 40"),
    (_mut(lambda c: c["angles"][0].update(tone="warm")), "angles[1] has unknown key(s): tone"),
    (_mut(lambda c: c.update(batch_size=0)), "batch_size must be a whole number from 1 to 100"),
    (_mut(lambda c: c.update(colour="orange")), "Unknown configuration key"),
])
def test_invalid_config(cfg, message):
    with pytest.raises(ConfigError) as e:
        load_config(cfg)
    assert message in str(e.value)


def test_cli_plan_mode_makes_no_calls(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    code = cli_main(RECIPE, ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"),
                             "--out", str(tmp_path)])
    assert code == 0
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 1.2
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
