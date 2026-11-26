"""AI momentum watchlist: which accounts show recent AI momentum worth acting on now.

Workflow:
1. Read the accounts, each by `company_id` or `domain`. Invalid identifiers are reported and skipped.
2. Send the unique valid accounts to POST /ai-adoption in `records` batches, without evidence.
3. For each account, compare the returned momentum label with the configured `labels`, and check each
   momentum signal's `latest` date against `evaluation_date` and `recent_days`. `signal_kinds`, when
   set, limits which signals count.
4. Assign a status: `watch`, `label_only`, `not_watch`, `not_found`, `invalid_input`, `error` or
   `not_processed`.

Labels and signals are shown as returned. This code computes no score and no trend. Momentum does
not prove buying intent.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError, FirmableError, InvalidResponseError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext, parse_date
from firmable_client.report import Raw, badge, esc, note, table

NAME = "ai-momentum-watchlist"
TITLE = "AI momentum watchlist"
DESCRIPTION = ("Flags accounts whose AI Adoption momentum label is one you chose and whose momentum signals are "
               "recent, with every label, signal and date shown as returned.")

TOP_KEYS = {"labels", "signal_kinds", "recent_days", "evaluation_date", "batch_size"}
STATUS_ORDER = ["watch", "label_only", "not_watch", "not_found", "invalid_input", "error", "not_processed"]
STATUS_TONE = {"watch": "good", "label_only": "review", "not_watch": "neutral", "not_found": "unknown",
               "invalid_input": "error", "error": "error", "not_processed": "unknown"}
STATUS_HEADINGS = {
    "watch": "Watch: qualifying label and at least one recent signal",
    "label_only": "Label only: qualifying label, no recent dated signal",
    "not_watch": "Not on the watchlist",
    "not_found": "No AI adoption data",
    "invalid_input": "Invalid input",
    "error": "Errors",
    "not_processed": "Not processed",
}
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


# ----- configuration and input --------------------------------------------------------------------

def _whole(raw: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    v = raw.get(key, default)
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise ConfigError(f"{key} must be a whole number from {lo} to {hi}.")
    return v


def _text_list(value: Any, key: str, message: str) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x.strip() for x in value):
        raise ConfigError(message)
    out: list[str] = []
    seen: set[str] = set()
    for x in value:
        if x.strip().upper() in seen:
            raise ConfigError(f"{key} repeats {x.strip()}.")
        seen.add(x.strip().upper())
        out.append(x.strip())
    return out


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    labels = _text_list(raw.get("labels", ["EXPANDING"]), "labels",
                        "labels must be a non-empty list of non-empty text values.")
    kinds_raw = raw.get("signal_kinds")
    kinds = None if kinds_raw is None else _text_list(
        kinds_raw, "signal_kinds", "signal_kinds must be a non-empty list of non-empty text values, or left out.")
    if raw.get("evaluation_date") in (None, ""):
        raise ConfigError("evaluation_date is required, as YYYY-MM-DD.")
    evaluation = parse_date(raw["evaluation_date"], "evaluation_date").isoformat()
    return {"labels": labels, "signal_kinds": kinds,
            "recent_days": _whole(raw, "recent_days", 90, 1, 3650),
            "evaluation_date": evaluation,
            "batch_size": _whole(raw, "batch_size", 100, 1, 100)}


def read_input(path: Path) -> list[dict[str, str]]:
    return read_rows(path, any_of=["domain", "company_id"])


def subject_of(row: dict[str, str]) -> tuple[dict[str, str] | None, str | None]:
    """The company to ask about: company_id when given, otherwise the normalised domain."""
    cid = (row.get("company_id") or "").strip()
    if cid:
        if not _COMPANY_ID.match(cid):
            return None, f"The company_id \"{cid}\" is not a valid Firmable company ID."
        return {"type": "company_id", "value": cid}, None
    raw = row.get("domain") or ""
    d = normalise_domain(raw)
    if not d:
        return None, f"The domain \"{raw}\" is not a valid domain."
    return {"type": "domain", "value": d}, None


def _key(subject: dict[str, str]) -> str:
    return f"{subject['type']}:{subject['value']}"


def _unique_subjects(rows: list[dict[str, str]]) -> list[str]:
    out: list[str] = []
    for r in rows:
        s, _ = subject_of(r)
        if s and _key(s) not in out:
            out.append(_key(s))
    return out


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(_unique_subjects(rows))
    size = config["batch_size"]
    return [PlannedCall("POST /ai-adoption", f"AI Adoption for each unique valid account, in batches of up to {size}",
                        (n + size - 1) // size, pricing.estimate_ai_adoption(n, False))]


# ----- batched AI Adoption ------------------------------------------------------------------------

def _s(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    return str(v)


def _row_error(code: Any, message: Any) -> dict[str, Any]:
    return {"kind": "row_error", "status": 200, "code": code, "endpoint": "POST /ai-adoption",
            "message": f"AI Adoption returned an error for this company: {_s(code) or 'no code'}: "
                       f"{_s(message) or 'no message'}", "charge_uncertain": False, "retry_after": None}


class BatchFetcher:
    """Sends unique companies in `records` batches, in input order, the first time a row needs one."""

    def __init__(self, ctx: RunContext, keys: list[str], subjects: dict[str, dict[str, str]],
                 external_ids: dict[str, str], batch_size: int) -> None:
        self.ctx = ctx
        self.subjects = subjects
        self.external_ids = external_ids
        self.batches = [{"keys": keys[i:i + batch_size], "status": "pending", "error": None}
                        for i in range(0, len(keys), batch_size)]
        self.batch_of = {k: i // batch_size for i, k in enumerate(keys)}
        self.answers: dict[str, Any] = {}

    def get(self, key: str, row_id: str) -> tuple[str, Any]:
        b = self.batches[self.batch_of[key]]
        if b["status"] == "pending":
            self._send(b, row_id)
        if b["status"] == "failed":
            return "error", b["error"]
        return self.answers[key]

    def _send(self, b: dict[str, Any], row_id: str) -> None:
        records = [{self.subjects[k]["type"]: self.subjects[k]["value"], "external_id": self.external_ids[k]}
                   for k in b["keys"]]
        try:
            resp = self.ctx.client.get_ai_adoption({"records": records})
            results = resp.get("results")
            if not isinstance(results, list) or len(results) != len(records):
                got = len(results) if isinstance(results, list) else 0
                self.ctx.client.budget.mark_uncertain()
                raise InvalidResponseError(
                    f"The AI Adoption batch answer has {got} result(s) for {len(records)} record(s) sent.",
                    status=200, endpoint="POST /ai-adoption", charge_uncertain=True)
        except FirmableError as e:
            b["status"] = "failed"
            b["error"] = self.ctx.record_error(row_id, e)
            return
        b["status"] = "done"
        for k, rec, ans in zip(b["keys"], records, results):
            echoed = (ans.get("input") or {}).get("external_id") if isinstance(ans.get("input"), dict) else None
            if echoed is not None and echoed != rec["external_id"]:
                self.answers[k] = ("mismatch", {
                    "kind": "row_error", "status": 200, "code": "external_id_mismatch",
                    "endpoint": "POST /ai-adoption",
                    "message": f"The batch answer in this position carries external_id \"{_s(echoed)}\", not "
                               f"\"{rec['external_id']}\", so it was not used.",
                    "charge_uncertain": False, "retry_after": None})
            else:
                self.answers[k] = ("answer", ans)


def classify(ans: dict[str, Any]) -> str:
    if isinstance(ans.get("company"), dict):
        return "found"
    err = ans.get("error") if isinstance(ans.get("error"), dict) else {}
    if err.get("code") in (None, "not_found"):
        return "not_found"
    return "row_error"


# ----- watch rule ----------------------------------------------------------------------------------

def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def signal_date(latest: Any) -> _dt.date | None:
    """The date at the start of `latest` (YYYY-MM-DD, optionally followed by a time), or None."""
    if not isinstance(latest, str):
        return None
    m = _DATE.match(latest.strip())
    if not m:
        return None
    try:
        return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def assess(company: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    evaluation = _dt.date.fromisoformat(cfg["evaluation_date"])
    labels = {x.upper() for x in cfg["labels"]}
    kinds = None if cfg["signal_kinds"] is None else {x.upper() for x in cfg["signal_kinds"]}
    momentum = company.get("momentum") if isinstance(company.get("momentum"), dict) else {}
    label = momentum.get("label")
    label_text = _text(label)
    label_qualifies = bool(label_text) and label_text.upper() in labels
    signals = []
    for sig in momentum.get("signals") or []:
        if not isinstance(sig, dict):
            continue
        kind = _text(sig.get("kind"))
        selected = kinds is None or (kind is not None and kind.upper() in kinds)
        d = signal_date(sig.get("latest"))
        days = (evaluation - d).days if d else None
        if d is None:
            recency = "undated"
        elif days < 0:
            recency = "after_evaluation_date"
        elif days <= cfg["recent_days"]:
            recency = "recent"
        else:
            recency = "older"
        signals.append({"kind": sig.get("kind"), "count": sig.get("count"), "latest": sig.get("latest"),
                        "kind_selected": selected, "days_before_evaluation": days, "recency": recency})
    recent = [x for x in signals if x["kind_selected"] and x["recency"] == "recent"]
    notes = []
    undated = len([x for x in signals if x["kind_selected"] and x["recency"] == "undated"])
    after = len([x for x in signals if x["kind_selected"] and x["recency"] == "after_evaluation_date"])
    unselected = len([x for x in signals if not x["kind_selected"]])
    if undated:
        notes.append(f"{undated} selected signal(s) have no usable latest date. They are not counted as recent.")
    if after:
        notes.append(f"{after} selected signal(s) are dated after the evaluation date. They are not counted as recent.")
    if unselected:
        notes.append(f"{unselected} signal(s) are of a kind not in signal_kinds. They are shown but not counted.")
    window = f"within {cfg['recent_days']} days before {cfg['evaluation_date']}"
    latest_recent = max((str(x["latest"]) for x in recent), default=None)
    if label_qualifies and recent:
        status = "watch"
        reason = (f"Momentum label {label_text} is a configured label, and {len(recent)} selected signal(s) are "
                  f"dated {window}. The latest is {latest_recent}.")
    elif label_qualifies:
        status = "label_only"
        reason = f"Momentum label {label_text} is a configured label, but no selected signal is dated {window}."
    elif label_text is None:
        status = "not_watch"
        reason = ("AI Adoption returned no momentum label, so the watch rule is not met. This is not a finding of "
                  "no momentum.")
    else:
        status = "not_watch"
        reason = f"Momentum label {label_text} is not one of the configured labels."
    return {"status": status, "status_reason": reason,
            "momentum": {"label": label, "label_qualifies": label_qualifies, "signals": signals},
            "recent_signal_count": len(recent), "latest_recent_signal": latest_recent, "notes": notes}


# ----- run -----------------------------------------------------------------------------------------

def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    kinds_text = ", ".join(cfg["signal_kinds"]) if cfg["signal_kinds"] else "every kind"
    coverage = [
        "Accounts come from your input file. The REST API has no company search and no list of companies by "
        "momentum.",
        "Momentum labels and signals are shown as returned by the API. This code computes no score and no trend.",
        "AI momentum does not prove buying intent. A watch status means the configured rule matched, nothing more.",
        f"The watch rule: the momentum label is one of {', '.join(cfg['labels'])} (ignoring case), and at least one "
        f"signal of {kinds_text} has a latest date within {cfg['recent_days']} days before {cfg['evaluation_date']}.",
        "Recency uses each signal's latest date only. The API does not give earlier dates for a signal.",
        "An account with no AI adoption data is reported as not_found. It is not counted as having no momentum.",
    ]

    subjects: dict[str, dict[str, str]] = {}
    external_ids: dict[str, str] = {}
    keys: list[str] = []
    for r in ctx.rows:
        s, _ = subject_of(r)
        if s and _key(s) not in subjects:
            subjects[_key(s)] = s
            external_ids[_key(s)] = r["row_id"]
            keys.append(_key(s))
    fetcher = BatchFetcher(ctx, keys, subjects, external_ids, cfg["batch_size"])
    row_errors: dict[str, dict[str, Any]] = {}
    dupes = 0

    def one(row: dict[str, str]) -> dict[str, Any]:
        nonlocal dupes
        subject, problem = subject_of(row)
        base: dict[str, Any] = {"row_id": row["row_id"], "input": row, "subject": subject, "duplicate_of": None,
                                "company": None, "momentum": None, "recent_signal_count": None,
                                "latest_recent_signal": None, "notes": []}
        if subject is None:
            return {**base, "status": "invalid_input", "status_reason": problem}
        key = _key(subject)
        if external_ids[key] != row["row_id"]:
            base["duplicate_of"] = external_ids[key]
            dupes += 1
        kind, value = fetcher.get(key, row["row_id"])
        if kind == "error":
            msg = str(value.get("message") or "").rstrip(".")
            return {**base, "status": "error", "status_reason": f"AI Adoption could not be read: {msg}.",
                    "error": value}
        if kind == "mismatch":
            if key not in row_errors:
                row_errors[key] = ctx.record_error_dict(row["row_id"], value)
            return {**base, "status": "error", "status_reason": value["message"], "error": row_errors[key]}
        outcome = classify(value)
        if outcome == "row_error":
            if key not in row_errors:
                err = value.get("error") or {}
                row_errors[key] = ctx.record_error_dict(row["row_id"], _row_error(err.get("code"), err.get("message")))
            return {**base, "status": "error", "status_reason": row_errors[key]["message"] + ".",
                    "error": row_errors[key]}
        if outcome == "not_found":
            return {**base, "status": "not_found",
                    "status_reason": "Firmable holds no AI adoption data for this account, or could not match it. "
                                     "It is not counted as having no momentum."}
        c = value["company"]
        base["company"] = {"firmable_id": c.get("firmable_id"), "company_name": c.get("company_name"),
                           "overall_level": c.get("overall_level"), "as_of": c.get("as_of"),
                           "framework_version": c.get("framework_version")}
        return {**base, **assess(c, cfg)}

    rows = ctx.run_rows(ctx.rows, one)
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    unique = [r for r in rows if not r.get("duplicate_of")]
    found = [r for r in unique if r["status"] in ("watch", "label_only", "not_watch")]
    label_counts: dict[str, int] = {}
    for r in found:
        lb = _text((r.get("momentum") or {}).get("label")) or "not returned"
        label_counts[lb] = label_counts.get(lb, 0) + 1
    summary = {
        "rows_in_input": len(rows), "unique_accounts_asked": len(keys), "status_counts": counts,
        "accounts_with_data": len(found),
        "watch_among_accounts_with_data": len([r for r in found if r["status"] == "watch"]),
        "label_only_among_accounts_with_data": len([r for r in found if r["status"] == "label_only"]),
        "not_watch_among_accounts_with_data": len([r for r in found if r["status"] == "not_watch"]),
        "momentum_label_counts": label_counts,
    }
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier account; the earlier answer was reused, not requested again.")
    return {"rows": rows, "summary": summary, "coverage": coverage}


# ----- CSV and report ------------------------------------------------------------------------------

CSV_COLUMNS = ["row_id", "asked_by", "asked_value", "company_name", "segment", "duplicate_of", "status",
               "status_reason", "momentum_label", "recent_signals", "latest_recent_signal", "all_signals",
               "overall_level", "as_of", "firmable_id"]


def _sig_text(x: dict[str, Any]) -> str:
    return f"{_s(x.get('kind'))}: {_s(x.get('count'))}, latest {_s(x.get('latest')) or 'not returned'}"


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        company = r.get("company") or {}
        subject = r.get("subject") or {}
        signals = (r.get("momentum") or {}).get("signals") or []
        out.append({
            "row_id": r["row_id"], "asked_by": subject.get("type"),
            "asked_value": subject.get("value") or r["input"].get("company_id") or r["input"].get("domain"),
            "company_name": company.get("company_name") or r["input"].get("company_name"),
            "segment": r["input"].get("segment"), "duplicate_of": r.get("duplicate_of"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason"),
            "momentum_label": (r.get("momentum") or {}).get("label"),
            "recent_signals": [_sig_text(x) for x in signals if x["kind_selected"] and x["recency"] == "recent"],
            "latest_recent_signal": r.get("latest_recent_signal"),
            "all_signals": [_sig_text(x) for x in signals],
            "overall_level": company.get("overall_level"), "as_of": company.get("as_of"),
            "firmable_id": company.get("firmable_id")})
    return out


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    counts = s.get("status_counts", {})
    body = "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {counts[k]}", STATUS_TONE.get(k, "neutral"))
                            for k in STATUS_ORDER if k in counts) + "</p>"
    body += table(["Measure", "Count", "Out of"], [
        ["Accounts on the watchlist", s.get("watch_among_accounts_with_data"), f"{s.get('accounts_with_data')} accounts with AI adoption data"],
        ["Qualifying label, no recent signal", s.get("label_only_among_accounts_with_data"), f"{s.get('accounts_with_data')} accounts with AI adoption data"],
        ["Not on the watchlist", s.get("not_watch_among_accounts_with_data"), f"{s.get('accounts_with_data')} accounts with AI adoption data"],
        ["Accounts with AI adoption data", s.get("accounts_with_data"), f"{s.get('unique_accounts_asked')} unique accounts asked"],
    ])
    body += note("AI momentum does not prove buying intent. Counts describe the accounts in your file only.", "unknown")
    report.add("Result", "Watchlist summary", body)
    for status in STATUS_ORDER:
        rows = [r for r in result["rows"] if r["status"] == status]
        if not rows:
            continue
        trs = []
        for r in rows:
            company = r.get("company") or {}
            subject = r.get("subject") or {}
            signals = (r.get("momentum") or {}).get("signals") or []
            sig_html = "<br>".join(
                esc(f"{_sig_text(x)} ({x['recency'].replace('_', ' ')}"
                    + ("" if x["kind_selected"] else ", kind not selected") + ")") for x in signals) or "none returned"
            trs.append([r["row_id"], company.get("company_name") or r["input"].get("company_name") or subject.get("value")
                        or r["input"].get("domain") or r["input"].get("company_id"),
                        (r.get("momentum") or {}).get("label"), Raw(sig_html),
                        " ".join([r.get("status_reason") or r.get("reason") or ""] + (r.get("notes") or []))])
        report.add("Accounts", STATUS_HEADINGS[status],
                   table(["Row", "Account", "Momentum label", "Signals as returned", "Why"], trs))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render)
