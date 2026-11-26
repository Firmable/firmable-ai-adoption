"""AI outreach angles: per-account talk angles filled from fixed templates and AI Adoption facts.

Workflow:
1. Read the accounts, each by `company_id` or `domain`. Invalid identifiers are reported and skipped.
2. Send the unique valid accounts to POST /ai-adoption in `records` batches, without evidence.
3. For each account found, check every configured angle's conditions (overall level, one area's level,
   momentum label) against the returned facts. A condition on a fact that was not returned cannot be
   checked, and the angle is listed as not evaluated.
4. Fill each matching angle's template from the returned facts and the input. A template with a
   placeholder that has no value is skipped and listed.
5. Write `outreach-angles.md` with every angle beside the facts it used.

Angles are suggestions, not facts. No angle is produced for an account without AI adoption data.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError, FirmableError, InvalidResponseError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, bullet_list, card, esc, kv, note, table

NAME = "ai-outreach-angles"
TITLE = "AI outreach angles"
DESCRIPTION = ("Suggests outreach angles for each account from fixed templates, filled only with AI Adoption facts "
               "and your input, and shows each angle beside the facts it used.")

AREAS = ["architecture", "footprint", "hiring", "initiatives", "workforce"]
PLACEHOLDERS = ["company_name", "overall_level", "dimension", "dimension_level", "headline", "momentum"]
DIMENSION_PLACEHOLDERS = {"dimension", "dimension_level", "headline"}
TOP_KEYS = {"angles", "batch_size"}
WHEN_KEYS = {"overall_level_in", "dimension", "momentum_in"}
MAX_ANGLES = 20
STATUS_TONE = {"angles_found": "good", "no_angle": "neutral", "not_found": "unknown", "invalid_input": "error",
               "error": "error", "not_processed": "unknown"}
_ID = re.compile(r"^[a-z0-9_]{1,40}$")
_TOKEN = re.compile(r"\{([^{}]*)\}")
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_MD_SPECIAL = set("\\`*_[]<>|")


# ----- configuration and input --------------------------------------------------------------------

def _whole(raw: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    v = raw.get(key, default)
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise ConfigError(f"{key} must be a whole number from {lo} to {hi}.")
    return v


def _values(v: Any, where: str) -> list[str]:
    if not isinstance(v, list) or not v or not all(isinstance(x, str) and x.strip() for x in v):
        raise ConfigError(f"{where} must be a non-empty list of non-empty text values.")
    return [x.strip() for x in v]


def _placeholders(template: str) -> list[str]:
    out: list[str] = []
    for name in _TOKEN.findall(template):
        if name not in out:
            out.append(name)
    return out


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    angles_raw = raw.get("angles")
    if not isinstance(angles_raw, list) or not 1 <= len(angles_raw) <= MAX_ANGLES:
        raise ConfigError(f"angles must be a list of 1 to {MAX_ANGLES} angles.")
    angles: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, a in enumerate(angles_raw, start=1):
        where = f"angles[{i}]"
        if not isinstance(a, dict):
            raise ConfigError(f"{where} must be an object.")
        extra = sorted(set(a) - {"id", "when", "template"})
        if extra:
            raise ConfigError(f"{where} has unknown key(s): {', '.join(extra)}")
        aid = a.get("id")
        if not isinstance(aid, str) or not _ID.match(aid):
            raise ConfigError(f"{where}.id must be 1 to 40 lower-case letters, digits or underscores.")
        if aid in seen:
            raise ConfigError(f"{where}.id '{aid}' is used twice.")
        seen.add(aid)
        when_raw = a.get("when")
        if not isinstance(when_raw, dict) or not when_raw:
            raise ConfigError(f"{where}.when must be an object with at least one of overall_level_in, dimension, "
                              "momentum_in.")
        extra = sorted(set(when_raw) - WHEN_KEYS)
        if extra:
            raise ConfigError(f"{where}.when has unknown key(s): {', '.join(extra)}")
        when: dict[str, Any] = {}
        if "overall_level_in" in when_raw:
            when["overall_level_in"] = _values(when_raw["overall_level_in"], f"{where}.when.overall_level_in")
        if "dimension" in when_raw:
            d = when_raw["dimension"]
            if not isinstance(d, dict) or sorted(d) != ["level_in", "name"]:
                raise ConfigError(f"{where}.when.dimension must be an object with name and level_in only.")
            if d["name"] not in AREAS:
                raise ConfigError(f"{where}.when.dimension.name must be one of {', '.join(AREAS)}.")
            when["dimension"] = {"name": d["name"], "level_in": _values(d["level_in"], f"{where}.when.dimension.level_in")}
        if "momentum_in" in when_raw:
            when["momentum_in"] = _values(when_raw["momentum_in"], f"{where}.when.momentum_in")
        template = a.get("template")
        if not isinstance(template, str) or not template.strip():
            raise ConfigError(f"{where}.template must be non-empty text.")
        rest = _TOKEN.sub("", template)
        if "{" in rest or "}" in rest:
            raise ConfigError(f"{where}.template has an unmatched brace.")
        names = _placeholders(template)
        for name in names:
            if name not in PLACEHOLDERS:
                raise ConfigError(f"{where}.template uses {{{name}}}, which is not one of: "
                                  + ", ".join("{" + p + "}" for p in PLACEHOLDERS) + ".")
            if name in DIMENSION_PLACEHOLDERS and "dimension" not in when:
                raise ConfigError(f"{where}.template uses {{{name}}}, which needs when.dimension.")
        angles.append({"id": aid, "when": when, "template": template.strip(), "placeholders": names})
    return {"angles": angles, "batch_size": _whole(raw, "batch_size", 100, 1, 100)}


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


# ----- angles --------------------------------------------------------------------------------------

def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def company_facts(c: dict[str, Any]) -> dict[str, Any]:
    dims = c.get("dimensions") if isinstance(c.get("dimensions"), dict) else {}
    momentum = c.get("momentum") if isinstance(c.get("momentum"), dict) else {}
    return {
        "firmable_id": c.get("firmable_id"), "company_name": c.get("company_name"),
        "overall_level": c.get("overall_level"), "momentum_label": momentum.get("label"),
        "as_of": c.get("as_of"), "framework_version": c.get("framework_version"),
        "dimensions": {a: {"level": dims[a].get("level"), "headline": dims[a].get("headline")}
                       if isinstance(dims.get(a), dict) else None for a in AREAS},
    }


def _check(condition: str, field: str, returned: Any, wanted: list[str]) -> dict[str, Any]:
    t = _text(returned)
    if t is None:
        result = "unknown"
    else:
        result = "yes" if t.upper() in {w.upper() for w in wanted} else "no"
    return {"condition": condition, "field": field, "returned": returned, "wanted": wanted, "result": result}


def evaluate(angle: dict[str, Any], facts: dict[str, Any], row: dict[str, str]) -> dict[str, Any]:
    when = angle["when"]
    checks = []
    if "overall_level_in" in when:
        checks.append(_check("overall_level_in", "overall_level", facts["overall_level"], when["overall_level_in"]))
    dim = when.get("dimension")
    dim_facts = (facts["dimensions"].get(dim["name"]) or {}) if dim else {}
    if dim:
        checks.append(_check("dimension.level_in", f"dimensions.{dim['name']}.level", dim_facts.get("level"),
                             dim["level_in"]))
    if "momentum_in" in when:
        checks.append(_check("momentum_in", "momentum.label", facts["momentum_label"], when["momentum_in"]))
    if any(c["result"] == "no" for c in checks):
        return {"id": angle["id"], "result": "not_matched", "conditions": checks}
    if any(c["result"] == "unknown" for c in checks):
        return {"id": angle["id"], "result": "not_evaluated", "conditions": checks,
                "unknown_fields": [c["field"] for c in checks if c["result"] == "unknown"]}
    sources = {
        "company_name": (_text(facts["company_name"]), "AI Adoption company_name") if _text(facts["company_name"])
        else (_text(row.get("company_name")), "input company_name"),
        "overall_level": (_text(facts["overall_level"]), "AI Adoption overall_level"),
        "momentum": (_text(facts["momentum_label"]), "AI Adoption momentum.label"),
    }
    if dim:
        sources["dimension"] = (dim["name"], "configuration when.dimension.name")
        sources["dimension_level"] = (_text(dim_facts.get("level")), f"AI Adoption dimensions.{dim['name']}.level")
        sources["headline"] = (_text(dim_facts.get("headline")), f"AI Adoption dimensions.{dim['name']}.headline")
    used, missing = [], []
    for name in angle["placeholders"]:
        value, source = sources[name]
        if value is None:
            missing.append(name)
        else:
            used.append({"placeholder": name, "value": value, "source": source})
    if missing:
        return {"id": angle["id"], "result": "skipped", "conditions": checks, "missing": missing}
    values = {u["placeholder"]: u["value"] for u in used}
    text = _TOKEN.sub(lambda m: values[m.group(1)], angle["template"])
    return {"id": angle["id"], "result": "filled", "kind": "suggested_angle", "text": text,
            "template": angle["template"], "conditions": checks, "filled_from": used}


# ----- run -----------------------------------------------------------------------------------------

def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    coverage = [
        "Accounts come from your input file. The REST API has no company search.",
        "Angles are filled from fixed templates in the configuration, using only AI Adoption facts and the input "
        "company_name. They are suggestions, not facts.",
        "Levels and labels are matched by name only. This code does not order levels, compute a score or infer "
        "a trend.",
        "An AI adoption level or momentum label does not prove buying intent.",
        "No angle is produced for an account without AI adoption data. That is not a finding of no AI adoption.",
        "A condition on a fact the API did not return cannot be checked. The angle is listed as not evaluated, "
        "not as failed.",
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
                                "company": None, "angles": [], "skipped_angles": [], "not_evaluated_angles": [],
                                "not_matched_angles": []}
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
                    "status_reason": "Firmable holds no AI adoption data for this account, or could not match it, so "
                                     "no angle was produced. This is not a finding of no AI adoption."}
        facts = company_facts(value["company"])
        base["company"] = facts
        for angle in cfg["angles"]:
            res = evaluate(angle, facts, row)
            if res["result"] == "filled":
                base["angles"].append(res)
            elif res["result"] == "skipped":
                base["skipped_angles"].append({"id": res["id"], "missing": res["missing"]})
            elif res["result"] == "not_evaluated":
                base["not_evaluated_angles"].append({"id": res["id"], "unknown_fields": res["unknown_fields"]})
            else:
                base["not_matched_angles"].append(res["id"])
        n = len(base["angles"])
        if n:
            return {**base, "status": "angles_found",
                    "status_reason": f"{n} angle(s) matched the returned facts and were filled."}
        return {**base, "status": "no_angle",
                "status_reason": "No angle matched the returned facts and could be filled."}

    rows = ctx.run_rows(ctx.rows, one)
    counts: dict[str, int] = {}
    angle_counts: dict[str, int] = {a["id"]: 0 for a in cfg["angles"]}
    skipped: dict[str, int] = {}
    not_evaluated: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        if r.get("duplicate_of"):
            continue
        for a in r.get("angles") or []:
            angle_counts[a["id"]] += 1
        for a in r.get("skipped_angles") or []:
            skipped[a["id"]] = skipped.get(a["id"], 0) + 1
        for a in r.get("not_evaluated_angles") or []:
            not_evaluated[a["id"]] = not_evaluated.get(a["id"], 0) + 1
    with_data = len([r for r in rows if not r.get("duplicate_of") and r["status"] in ("angles_found", "no_angle")])
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier account; the earlier answer was reused, not requested again.")
    if skipped:
        coverage.append("Some matching angles were skipped because a placeholder had no value: "
                        + ", ".join(f"{k} ({v} account(s))" for k, v in skipped.items()) + ".")
    if not_evaluated:
        coverage.append("Some angles could not be evaluated because a fact they need was not returned: "
                        + ", ".join(f"{k} ({v} account(s))" for k, v in not_evaluated.items()) + ".")
    summary = {"rows_in_input": len(rows), "unique_accounts_asked": len(keys), "accounts_with_data": with_data,
               "status_counts": counts, "angle_counts_among_accounts_with_data": angle_counts,
               "skipped_angle_counts": skipped, "not_evaluated_angle_counts": not_evaluated}
    return {"rows": rows, "summary": summary, "coverage": coverage}


# ----- Markdown ------------------------------------------------------------------------------------

def md(value: Any) -> str:
    """Escapes Markdown special characters in API or input text and keeps it on one line."""
    t = _s(value).replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    out = "".join("\\" + ch if ch in _MD_SPECIAL else ch for ch in t)
    return "\\" + out if out.startswith("#") else out


def _mv(value: Any) -> str:
    return "not returned" if value is None or value == "" else md(value)


def _condition_label(c: dict[str, Any]) -> str:
    return f"Condition: {c['field']} is one of {', '.join(c['wanted'])}"


def _account_name(r: dict[str, Any]) -> Any:
    return ((r.get("company") or {}).get("company_name") or r["input"].get("company_name")
            or (r.get("subject") or {}).get("value") or r["input"].get("domain") or r["input"].get("company_id")
            or r["row_id"])


def outreach_markdown(result: dict[str, Any]) -> str:
    lines = ["# Outreach angles", "",
             "Each angle is filled from a fixed template in the configuration, using only AI Adoption facts and the "
             "company name in your input. An angle is a suggestion, not a fact. An AI adoption level or momentum "
             "label does not prove buying intent.", ""]
    for r in result["rows"]:
        lines += [f"## {md(_account_name(r))} (row {md(r['row_id'])})", ""]
        if r.get("duplicate_of"):
            lines += [f"Same account as row {md(r['duplicate_of'])}. The angles are the same as for that row.", ""]
            continue
        c = r.get("company")
        if r["status"] not in ("angles_found", "no_angle"):
            lines += [f"No angle: {md(r.get('status_reason') or r.get('reason') or '')}", ""]
            continue
        lines += ["| Fact | Value as returned |", "| - | - |",
                  f"| Overall level (`overall_level`) | {_mv(c.get('overall_level'))} |",
                  f"| Momentum (`momentum.label`) | {_mv(c.get('momentum_label'))} |",
                  f"| Data as of (`as_of`) | {_mv(c.get('as_of'))} |", ""]
        if not r["angles"]:
            lines += ["No angle matched the returned facts and could be filled.", ""]
        for a in r["angles"]:
            lines += [f"### Angle `{a['id']}`", "", "> **Suggested, not a fact**", ">", f"> {md(a['text'])}", "",
                      "| Used for this angle | Value | Source |", "| - | - | - |"]
            for ch in a["conditions"]:
                lines.append(f"| {md(_condition_label(ch))} | {_mv(ch['returned'])} | AI Adoption `{ch['field']}` |")
            for u in a["filled_from"]:
                lines.append(f"| Placeholder `{{{u['placeholder']}}}` | {md(u['value'])} | {md(u['source'])} |")
            lines.append("")
        if r["skipped_angles"]:
            lines += ["Matching angles skipped because a placeholder had no value:", ""]
            lines += [f"- `{s['id']}`: missing " + ", ".join(f"`{{{m}}}`" for m in s["missing"]) for s in r["skipped_angles"]]
            lines.append("")
        if r["not_evaluated_angles"]:
            lines += ["Angles not evaluated because a fact they need was not returned:", ""]
            lines += [f"- `{s['id']}`: " + ", ".join(f"`{f}`" for f in s["unknown_fields"]) + " not returned"
                      for s in r["not_evaluated_angles"]]
            lines.append("")
    return "\n".join(lines)


def markdown(result: dict[str, Any]) -> dict[str, str]:
    return {"outreach-angles.md": outreach_markdown(result)}


# ----- CSV and report ------------------------------------------------------------------------------

CSV_COLUMNS = ["row_id", "asked_by", "asked_value", "company_name", "segment", "duplicate_of", "status",
               "status_reason", "overall_level", "momentum_label", "angle_ids", "suggested_angles",
               "skipped_angles", "not_evaluated_angles", "firmable_id", "as_of"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        c = r.get("company") or {}
        subject = r.get("subject") or {}
        out.append({
            "row_id": r["row_id"], "asked_by": subject.get("type"),
            "asked_value": subject.get("value") or r["input"].get("company_id") or r["input"].get("domain"),
            "company_name": c.get("company_name") or r["input"].get("company_name"),
            "segment": r["input"].get("segment"), "duplicate_of": r.get("duplicate_of"), "status": r["status"],
            "status_reason": r.get("status_reason") or r.get("reason"),
            "overall_level": c.get("overall_level"), "momentum_label": c.get("momentum_label"),
            "angle_ids": [a["id"] for a in r.get("angles") or []],
            "suggested_angles": [a["text"] for a in r.get("angles") or []],
            "skipped_angles": [a["id"] for a in r.get("skipped_angles") or []],
            "not_evaluated_angles": [a["id"] for a in r.get("not_evaluated_angles") or []],
            "firmable_id": c.get("firmable_id"), "as_of": c.get("as_of")})
    return out


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    counts = s.get("status_counts", {})
    body = "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                            for k, v in counts.items()) + "</p>"
    body += table(["Angle", "Accounts where it was filled", "Out of"],
                  [[k, v, f"{s.get('accounts_with_data')} accounts with AI adoption data"]
                   for k, v in (s.get("angle_counts_among_accounts_with_data") or {}).items()])
    body += note("Angles are suggestions from fixed templates, not facts. An AI adoption level or momentum label "
                 "does not prove buying intent.", "unknown")
    report.add("Result", "Angle summary", body)
    cards = []
    for r in result["rows"]:
        status = r["status"]
        c = r.get("company")
        left = f"<p>{esc(r.get('status_reason') or r.get('reason') or '')}</p>"
        if r.get("duplicate_of"):
            left += note(f"Same account as row {esc(r['duplicate_of'])}; the answer was reused.", "info")
        right = ""
        if c:
            left += "<h3>Facts as returned</h3>" + kv([
                ("Firmable ID", c.get("firmable_id")), ("Overall level", c.get("overall_level")),
                ("Momentum label", c.get("momentum_label")), ("Data as of", c.get("as_of"))])
            left += table(["Area", "Level", "Headline"], [
                [a, (c["dimensions"].get(a) or {}).get("level"), (c["dimensions"].get(a) or {}).get("headline")]
                for a in AREAS])
            for a in r["angles"]:
                facts = [[_condition_label(ch), ch["returned"], ch["field"]] for ch in a["conditions"]]
                facts += [["{" + u["placeholder"] + "}", u["value"], u["source"]] for u in a["filled_from"]]
                right += (f"<div class=\"template\"><p><strong>Suggested, not a fact</strong> ({esc(a['id'])})</p>"
                          f"<p>{esc(a['text'])}</p>" + table(["Used", "Value", "Source"], facts) + "</div>")
            extra = [Raw(esc(f"{x['id']}: skipped, missing " + ", ".join(x["missing"]))) for x in r["skipped_angles"]]
            extra += [Raw(esc(f"{x['id']}: not evaluated, " + ", ".join(x["unknown_fields"]) + " not returned"))
                      for x in r["not_evaluated_angles"]]
            if extra:
                right += "<p class=\"muted\">Angles not produced:</p>" + bullet_list(extra)
        cards.append(card(str(_account_name(r)), badge(status.replace("_", " "), STATUS_TONE.get(status, "neutral")),
                          left, right or "<p class=\"muted\">No angle for this row.</p>", sub=f"Row {r['row_id']}"))
    report.add("Accounts", "Angles for each account", "".join(cards))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render,
                markdown=markdown)
