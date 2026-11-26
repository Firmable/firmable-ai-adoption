import csv
import json

import pytest

from ai_momentum_watchlist.recipe import RECIPE, load_config, plan
from firmable_client.cli import main as cli_main
from firmable_client.errors import ConfigError
from firmable_client.testing import fixtures_dir, run_with_fixtures

F = fixtures_dir("ai-momentum-watchlist")
BASE = {"evaluation_date": "2026-11-20"}


def run(name, max_credits=100.0, out=None):
    cfg = F / f"{name}.config.json"
    return run_with_fixtures(RECIPE, input_path=F / f"{name}.input.csv",
                             config_path=cfg if cfg.exists() else F / "config.json",
                             scenario=F / f"{name}.scenario.json", max_credits=max_credits, out_dir=out)


def by_id(result):
    return {r["row_id"]: r for r in result["rows"]}


def test_statuses_in_one_batch_without_evidence():
    result, transport = run("happy")
    rows = by_id(result)
    assert {k: r["status"] for k, r in rows.items()} == {
        "w1": "watch", "w2": "label_only", "w3": "not_watch", "w4": "not_watch", "w5": "not_found",
        "w6": "watch", "w7": "invalid_input", "w8": "watch", "w9": "error"}
    assert len(transport.sent) == 1 and transport.sent[0].query == {}
    assert transport.unused() == []
    assert rows["w6"]["duplicate_of"] == "w1"


def test_signals_are_kept_as_returned_with_recency():
    result, _ = run("happy")
    sigs = by_id(result)["w1"]["momentum"]["signals"]
    assert sigs == [
        {"kind": "AI hiring", "count": 2, "latest": "2026-10-13", "kind_selected": True,
         "days_before_evaluation": 38, "recency": "recent"},
        {"kind": "AI initiatives", "count": 1, "latest": "2026-03-01", "kind_selected": True,
         "days_before_evaluation": 264, "recency": "older"}]
    assert by_id(result)["w1"]["latest_recent_signal"] == "2026-10-13"


def test_label_only_undated_future_and_timestamp_signals():
    result, _ = run("happy")
    rows = by_id(result)
    assert rows["w2"]["notes"] == ["1 selected signal(s) have no usable latest date. They are not counted as recent."]
    z = rows["w8"]
    assert z["momentum"]["label"] == "accelerating" and z["momentum"]["label_qualifies"] is True
    assert [s["recency"] for s in z["momentum"]["signals"]] == ["after_evaluation_date", "recent", "undated"]


def test_missing_label_is_not_a_finding_of_no_momentum():
    result, _ = run("happy")
    rows = by_id(result)
    assert rows["w4"]["momentum"]["label"] is None
    assert rows["w4"]["status_reason"].endswith("This is not a finding of no momentum.")
    assert rows["w5"]["status_reason"].endswith("It is not counted as having no momentum.")


def test_summary_states_denominators():
    result, _ = run("happy")
    s = result["summary"]
    assert s["unique_accounts_asked"] == 7 and s["accounts_with_data"] == 5
    assert s["watch_among_accounts_with_data"] == 2
    assert s["momentum_label_counts"] == {"EXPANDING": 2, "STEADY": 1, "not returned": 1, "accelerating": 1}
    assert any("does not prove buying intent" in c for c in result["coverage"])


def test_signal_kind_filter_and_batches():
    result, transport = run("kinds")
    rows = by_id(result)
    assert rows["k1"]["status"] == "label_only"
    assert rows["k1"]["notes"] == ["1 signal(s) are of a kind not in signal_kinds. They are shown but not counted."]
    assert rows["k2"]["status"] == "watch" and rows["k3"]["status"] == "not_found"
    assert len(transport.sent) == 2


def test_errors_and_402_stop():
    result, transport = run("errors")
    rows = by_id(result)
    assert rows["e1"]["error"]["status"] == 500
    assert rows["e2"]["error"] == rows["e1"]["error"]
    assert rows["e3"]["error"]["kind"] == "invalid_response"
    assert rows["e5"]["error"]["kind"] == "insufficient_credits"
    assert rows["e6"]["status"] == "not_processed" and rows["e7"]["status"] == "not_processed"
    assert [e["kind"] for e in result["errors"]] == ["server_error", "invalid_response", "insufficient_credits"]
    assert len(transport.sent) == 3


def test_budget_stops_before_second_batch():
    result, transport = run("budget", max_credits=1.5)
    rows = by_id(result)
    assert rows["row-1"]["status"] == "watch" and rows["row-2"]["status"] == "not_watch"
    assert rows["row-3"]["error"]["kind"] == "budget_exceeded"
    assert len(transport.sent) == 1


def test_csv_and_report(tmp_path):
    run("happy", out=tmp_path)
    rows = list(csv.DictReader((tmp_path / "results.csv").open()))
    assert [r["row_id"] for r in rows] == ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9"]
    assert rows[0]["recent_signals"] == "AI hiring: 2, latest 2026-10-13"
    assert rows[0]["segment"] == "Enterprise"
    assert rows[7]["company_name"] == "Zeta Example"
    html = (tmp_path / "report.html").read_text()
    assert "does not prove buying intent" in html


def test_plan_counts_batches():
    cfg = load_config({**BASE, "batch_size": 3})
    rows = RECIPE.read_input(F / "happy.input.csv")
    (call,) = plan(rows, cfg)
    assert call.requests == 3
    assert call.to_dict()["published_estimate_upper_bound"] == 1.4


@pytest.mark.parametrize("raw,message", [
    ({}, "evaluation_date is required"),
    ({"evaluation_date": "2026-02-30"}, "evaluation_date must be a date as YYYY-MM-DD"),
    ({**BASE, "labels": []}, "labels must be a non-empty list"),
    ({**BASE, "labels": ["EXPANDING", ""]}, "labels must be a non-empty list"),
    ({**BASE, "labels": ["EXPANDING", "expanding"]}, "labels repeats expanding"),
    ({**BASE, "signal_kinds": []}, "signal_kinds must be a non-empty list"),
    ({**BASE, "recent_days": 0}, "recent_days must be a whole number from 1 to 3650"),
    ({**BASE, "batch_size": 101}, "batch_size must be a whole number from 1 to 100"),
    ({**BASE, "colour": "orange"}, "Unknown configuration key"),
])
def test_invalid_config(raw, message):
    with pytest.raises(ConfigError, match=message):
        load_config(raw)


def test_default_labels():
    assert load_config(BASE)["labels"] == ["EXPANDING"]
    assert load_config(BASE)["signal_kinds"] is None


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


def test_cli_rejects_bad_input(tmp_path):
    bad = tmp_path / "in.csv"
    bad.write_text("name\nAcme\n")
    assert cli_main(RECIPE, ["--input", str(bad), "--config", str(F / "config.json"), "--out", str(tmp_path)]) == 2
