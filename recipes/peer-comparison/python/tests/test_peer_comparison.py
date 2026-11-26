import csv
import json

import pytest

from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError, InputError
from firmable_client.testing import fixtures_dir, run_with_fixtures
from peer_comparison.recipe import RECIPE, load_config, md, plan

F = fixtures_dir("peer-comparison")


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json" if (F / f"{name}.config.json").exists() else F / "config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv", config_path=cfg,
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def comparison(result, measure):
    return next(c for c in result["summary"]["comparisons"] if c["measure"] == measure)


def test_happy_path_statuses_and_one_batch():
    result, transport = run("happy")
    rows = by_id(result)
    assert rows["f"]["status"] == "found" and rows["f"]["role"] == "focus"
    assert rows["p3"]["role"] == "peer"                        # "Peer" in the input is normalised
    assert rows["p4"]["status"] == "not_found"
    assert rows["p6"]["duplicate_of"] == "p1"
    assert rows["p7"]["status"] == "invalid_input"
    assert rows["p8"]["status"] == "excluded" and rows["p9"]["status"] == "excluded"
    assert len(transport.sent) == 1 and len(transport.sent[0].json_body["records"]) == 7
    assert transport.unused() == []


def test_placement_states_its_denominator():
    result, _ = run("happy")
    overall = comparison(result, "overall_level")
    assert overall["focus_value"] == "STRONG"
    assert overall["placement"] == "Same level as 2 of 4 peers with data."
    assert overall["peers_no_value"] == 1                     # the not found peer, never counted as no adoption
    hiring = comparison(result, "hiring")
    assert hiring["peers_with_value"] == 3 and hiring["peers_no_value"] == 2
    assert hiring["focus_observability"] == "HIGH"
    workforce = comparison(result, "workforce")
    assert [d["value"] for d in workforce["distribution"]] == ["BASIC", "STRONG", "EMERGING"]
    mom = comparison(result, "momentum")
    assert mom["placement"] == "Same momentum label as 3 of 4 peers with data."


def test_peer_cohort_is_described_from_the_input():
    result, _ = run("happy")
    pc = result["summary"]["peer_cohort"]
    assert (pc["peer_rows"], pc["companies"], pc["found"], pc["not_found"], pc["invalid_input"]) == (9, 6, 4, 1, 1)
    assert pc["excluded_as_focus"] == 2
    assert pc["segments"] == [{"segment": "Listed", "rows": 3}, {"segment": "Private", "rows": 5},
                              {"segment": "(blank)", "rows": 1}]
    assert result["summary"]["peers_not_found"] == [{"row_id": "p4", "subject": "peer-four.example"}]
    cov = " ".join(result["coverage"])
    assert "It does not represent an industry" in cov and "EMERGING" in cov


def test_same_level_flag_in_csv(tmp_path):
    run("happy", out=tmp_path)
    rows = {r["row_id"]: r for r in csv.DictReader((tmp_path / "results.csv").open())}
    assert rows["p1"]["same_overall_level_as_focus"] == "yes"
    assert rows["p2"]["same_overall_level_as_focus"] == "no"
    assert rows["p4"]["same_overall_level_as_focus"] == ""
    assert rows["f"]["same_overall_level_as_focus"] == ""


def test_markdown_escapes_api_text(tmp_path):
    run("happy", out=tmp_path)
    text = (tmp_path / "peer-comparison.md").read_text()
    assert "\\# Synthetic \\[link\\](javascript:alert(1)) \\<b\\>bold\\</b\\> \\| pipe\\_and \\*stars\\*" in text
    assert "Same level as 2 of 4 peers with data." in text
    assert "## Peers not found" in text and "Row p4: peer-four.example" in text
    html = (tmp_path / "report.html").read_text()
    assert "<b>Peer</b>" not in html and "&lt;b&gt;Peer&lt;/b&gt;" in html


def test_md_helper():
    assert md(None) == "not returned"
    assert md("# a|b_c") == "\\# a\\|b\\_c"
    assert md("line\nbreak") == "line break"


def test_focus_not_found_is_not_placed():
    result, _ = run("focus-not-found")
    overall = comparison(result, "overall_level")
    assert result["summary"]["focus"]["status"] == "not_found"
    assert overall["focus_value"] is None and overall["same_as_focus"] is None
    assert overall["placement"] == "The focus company has no value for this measure, so it is not placed."
    assert overall["too_few_answers"] is True                 # 2 peers, default min_answered 5
    assert any("no measure places it" in c for c in result["coverage"])


def test_too_few_answers_when_focus_found(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"min_answered": 5}))
    result, _ = run_with_fixtures(RECIPE, input_path=F / "happy.input.csv", config_path=cfg,
                                  scenario=F / "happy.scenario.json")
    overall = comparison(result, "overall_level")
    assert overall["placement"] == "Too few answers to compare: 4 peer(s) with a value, fewer than 5."
    assert overall["same_as_focus"] is None


def test_errors_and_402_stop():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["f"]["status"] == "error" and rows["f"]["error"]["status"] == 503
    assert rows["p2"]["status"] == "found" and rows["p3"]["status"] == "found"
    assert rows["p4"]["error"]["kind"] == "insufficient_credits"
    assert rows["p6"]["status"] == "not_processed"
    assert len(transport.sent) == 3
    assert result["coverage"][0].startswith("The run stopped early")
    assert len(result["summary"]["peers_without_answer"]) == 4


def test_evidence_query_and_truncation():
    result, transport = run("evidence")
    assert transport.sent[0].query == {"withEvidence": "true"}
    assert result["summary"]["focus"]["evidence_summary"]["hiring"]["truncated"] is True
    assert any("truncated" in c for c in result["coverage"])


@pytest.mark.parametrize("text,message", [
    ("role,domain\npeer,a.example\npeer,b.example\n", "exactly one row must have role focus; found 0"),
    ("role,domain\nfocus,a.example\nfocus,b.example\n", "found 2"),
    ("role,domain\nfocus,a.example\nrival,b.example\n", "role must be focus or peer, not 'rival'"),
    ("domain\na.example\n", "missing column(s): role"),
])
def test_invalid_input(tmp_path, text, message):
    p = tmp_path / "in.csv"
    p.write_text(text)
    with pytest.raises(InputError, match=message.replace("(", r"\(").replace(")", r"\)")):
        RECIPE.read_input(p)


@pytest.mark.parametrize("mutate,message", [
    (lambda c: c.update(min_answered=0), "min_answered must be a whole number"),
    (lambda c: c.update(with_evidence=1), "with_evidence must be true or false"),
    (lambda c: c.update(batch_size=500), "batch_size must be a whole number from 1 to 100"),
    (lambda c: c.update(group_by="segment"), "Unknown configuration key"),
])
def test_invalid_config(mutate, message):
    cfg = json.loads((F / "config.json").read_text())
    mutate(cfg)
    with pytest.raises(ConfigError, match=message):
        load_config(cfg)


def test_plan_counts_unique_valid_companies():
    cfg = load_config(json.loads((F / "config.json").read_text()))
    [call] = plan(RECIPE.read_input(F / "happy.input.csv"), cfg)
    assert call.requests == 1
    assert call.to_dict()["published_estimate_upper_bound"] == 1.4   # 7 unique valid companies at 0.2


def test_cli_plan_mode_makes_no_calls(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    code = cli_main(RECIPE, ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"),
                             "--out", str(tmp_path)])
    assert code == 0
    assert json.loads((tmp_path / "plan.json").read_text())["published_estimate_upper_bound"] == 1.4
    assert "no API calls were made" in capsys.readouterr().out


def test_cli_live_needs_limit_and_key(tmp_path, monkeypatch):
    args = ["--input", str(F / "happy.input.csv"), "--config", str(F / "config.json"), "--out", str(tmp_path)]
    assert cli_main(RECIPE, args + ["--live"]) == 2
    monkeypatch.delenv("FIRMABLE_API_KEY", raising=False)
    assert cli_main(RECIPE, args + ["--live", "--max-credits", "5"]) == 2


def test_cli_rejects_input_without_focus(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("role,domain\npeer,a.example\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
