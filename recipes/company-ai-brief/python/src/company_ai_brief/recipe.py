"""Company AI brief: what AI adoption evidence Firmable holds for each company, as a Markdown brief.

Workflow:
1. Read 1 to 25 companies, each by `company_id` or `domain`. Invalid identifiers are reported and skipped.
2. Send the unique valid companies to POST /ai-adoption in `records` batches (with evidence by default).
3. For each company, lay out the overall level, explanation and momentum as returned, then each of the
   five areas with its level, headline, observability, counts_toward_overall, the evidence count and up
   to `max_items_per_area` evidence items, split by the API's `qualifies` field.
4. Flag truncated evidence, evidence Firmable holds but did not return, areas with no data, levels that
   are not documented, and workforce items that name another organisation.
5. Write one Markdown brief per company: `ai-brief-<row_id>.md`.

This code computes no score, no trend and no narrative. "Not observed" never means "no adoption".
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError, FirmableError, InputError, InvalidResponseError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, bullet_list, card, details_json, esc, kv, note, table

NAME = "company-ai-brief"
TITLE = "Company AI brief"
DESCRIPTION = ("Builds a factual Markdown brief of the AI adoption evidence Firmable holds for each company: "
               "levels, explanation, momentum and evidence as returned, with qualifying and non-qualifying "
               "evidence kept apart and gaps stated.")

AREAS = ["architecture", "footprint", "hiring", "initiatives", "workforce"]
KNOWN_LEVELS = ["NONE", "BASIC", "MEANINGFUL", "MODERATE", "STRONG", "ADVANCED"]
BASE_AREA_KEYS = {"level", "headline", "observability", "counts_toward_overall"}
ORG_ID_FIELDS = ["company_id", "firmable_id", "organisation_id"]
ORG_NAME_FIELDS = ["company_name", "employer", "organisation", "company"]
TOP_KEYS = {"with_evidence", "max_items_per_area", "batch_size"}
MAX_ROWS = 25
STATUS_TONE = {"brief_ready": "good", "not_found": "unknown", "invalid_input": "error", "error": "error",
               "not_processed": "unknown"}
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_MD_SPECIAL = set("\\`*_[]<>|")
_SAFE_NAME = re.compile(r"[^A-Za-z0-9_-]")


# ----- configuration and input --------------------------------------------------------------------

def _whole(raw: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    v = raw.get(key, default)
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise ConfigError(f"{key} must be a whole number from {lo} to {hi}.")
    return v


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    with_evidence = raw.get("with_evidence", True)
    if not isinstance(with_evidence, bool):
        raise ConfigError("with_evidence must be true or false.")
    return {"with_evidence": with_evidence,
            "max_items_per_area": _whole(raw, "max_items_per_area", 5, 0, 100),
            "batch_size": _whole(raw, "batch_size", 100, 1, 100)}


def read_input(path: Path) -> list[dict[str, str]]:
    rows = read_rows(path, any_of=["domain", "company_id"])
    if len(rows) > MAX_ROWS:
        raise InputError(f"{Path(path).name} has {len(rows)} rows. This recipe takes 1 to {MAX_ROWS} companies.")
    return rows


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
    requests = (n + size - 1) // size
    what = "AI Adoption with evidence" if config["with_evidence"] else "AI Adoption"
    return [PlannedCall("POST /ai-adoption", f"{what} for each unique valid company, in batches of up to {size}",
                        requests, pricing.estimate_ai_adoption(n, config["with_evidence"]))]


# ----- batched AI Adoption ------------------------------------------------------------------------

def _row_error(code: Any, message: Any) -> dict[str, Any]:
    return {"kind": "row_error", "status": 200, "code": code, "endpoint": "POST /ai-adoption",
            "message": f"AI Adoption returned an error for this company: {_s(code) or 'no code'}: "
                       f"{_s(message) or 'no message'}", "charge_uncertain": False, "retry_after": None}


class BatchFetcher:
    """Sends unique companies in `records` batches, in input order, the first time a row needs one.

    A failed batch fails every company in it with the same error, recorded once. A row in a batch
    answer with its own `error` is that company's outcome; the other rows still count.
    """

    def __init__(self, ctx: RunContext, keys: list[str], subjects: dict[str, dict[str, str]],
                 external_ids: dict[str, str], batch_size: int, with_evidence: bool) -> None:
        self.ctx = ctx
        self.subjects = subjects
        self.external_ids = external_ids
        self.with_evidence = with_evidence
        self.batches = [{"keys": keys[i:i + batch_size], "status": "pending", "error": None}
                        for i in range(0, len(keys), batch_size)]
        self.batch_of = {k: i // batch_size for i, k in enumerate(keys)}
        self.answers: dict[str, Any] = {}

    def get(self, key: str, row_id: str) -> tuple[str, Any]:
        """Returns ("answer", answer), ("error", error entry) or ("mismatch", error entry)."""
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
            resp = self.ctx.client.get_ai_adoption({"records": records}, with_evidence=self.with_evidence)
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


# ----- brief content -------------------------------------------------------------------------------

def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _ints(v: Any) -> Any:
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, dict):
        return {k: _ints(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_ints(x) for x in v]
    return v


def _s(v: Any) -> str:
    """Formats an API value as text the same way as the TypeScript version."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (dict, list)):
        return json.dumps(_ints(v), ensure_ascii=False, separators=(",", ":"))
    return str(v)


def _other_org(item: dict[str, Any], company_id: Any, names: list[str]) -> list[dict[str, Any]]:
    found = []
    for field in ORG_ID_FIELDS:
        v = _text(item.get(field))
        if v and v != company_id:
            found.append({"field": field, "value": v})
    for field in ORG_NAME_FIELDS:
        v = _text(item.get(field))
        if v and v.lower() not in names:
            found.append({"field": field, "value": v})
    return found


def _area(area: str, dim: Any, available: Any, ev_all: Any, cfg: dict[str, Any], company_id: Any,
          names: list[str]) -> dict[str, Any]:
    dim = dim if isinstance(dim, dict) else None
    level = dim.get("level") if dim else None
    out: dict[str, Any] = {
        "area": area, "level": level,
        "level_documented": level in KNOWN_LEVELS if isinstance(level, str) else None,
        "headline": dim.get("headline") if dim else None,
        "observability": dim.get("observability") if dim else None,
        "counts_toward_overall": dim.get("counts_toward_overall") if dim else None,
        "evidence_available": available,
        "detail": {k: v for k, v in dim.items() if k not in BASE_AREA_KEYS} if dim else {},
        "flags": [], "notes": [],
    }
    if dim is None:
        out["flags"].append("The API returned no data for this area.")
    elif isinstance(level, str) and level not in KNOWN_LEVELS:
        out["notes"].append(f"The level {level} is not one of the documented levels. It is shown as returned.")
    if not cfg["with_evidence"]:
        out["evidence"] = {"status": "not_requested"}
        return out
    ev = ev_all.get(area) if isinstance(ev_all, dict) else None
    if not isinstance(ev, dict):
        out["evidence"] = {"status": "not_returned"}
        if isinstance(available, (int, float)) and not isinstance(available, bool) and available > 0:
            out["flags"].append(f"Firmable holds {_s(available)} evidence item(s) for this area, but none were returned.")
        else:
            out["notes"].append("Not observed: no evidence was returned for this area. This does not mean the "
                                "company has no AI activity in this area.")
        return out
    items = [i for i in (ev.get("items") or []) if isinstance(i, dict)]
    limit = cfg["max_items_per_area"]
    shown = items[:limit]
    count = ev.get("item_count")
    truncated = ev.get("truncated") is True
    if truncated:
        count_text = _s(count) if isinstance(count, (int, float)) and not isinstance(count, bool) else "an unknown number of"
        out["flags"].append(f"Evidence is truncated: {len(items)} of {count_text} item(s) were returned.")
    if len(items) > limit:
        out["notes"].append(f"This brief shows the first {limit} of {len(items)} returned item(s), in the order "
                            "the API returned them. Every returned item is in the raw responses.")
    unstated = [i for i in items if not isinstance(i.get("qualifies"), bool)]
    if unstated:
        out["notes"].append(f"{len(unstated)} evidence item(s) do not say whether they qualify.")
    if not items:
        out["notes"].append("The evidence entry for this area holds no items.")
    other = []
    if area == "workforce":
        for i in items:
            hits = _other_org(i, company_id, names)
            if hits:
                other.append({"ref": i.get("ref"), "fields": hits})
        if other:
            out["flags"].append(f"{len(other)} workforce evidence item(s) name a different organisation in fields "
                                "the API returned. They are shown as returned, not removed.")
    out["evidence"] = {
        "status": "returned", "as_of": ev.get("as_of"), "framework_version": ev.get("framework_version"),
        "item_count": count, "items_returned": len(items), "truncated": truncated,
        "qualifying_count": len([i for i in items if i.get("qualifies") is True]),
        "not_qualifying_count": len([i for i in items if i.get("qualifies") is False]),
        "unstated_count": len(unstated), "shown_limit": limit, "not_shown": len(items) - len(shown),
        "qualifying": [i for i in shown if i.get("qualifies") is True],
        "not_qualifying": [i for i in shown if i.get("qualifies") is False],
        "qualification_unstated": [i for i in shown if not isinstance(i.get("qualifies"), bool)],
        "other_organisation_items": other,
    }
    return out


def ai_section(ans: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    c = ans["company"]
    names = [n.lower() for n in [_text(c.get("company_name"))] if n]
    dims = c.get("dimensions") if isinstance(c.get("dimensions"), dict) else {}
    available = c.get("evidence_available") if isinstance(c.get("evidence_available"), dict) else {}
    momentum = c.get("momentum") if isinstance(c.get("momentum"), dict) else {}
    level = c.get("overall_level")
    notes = []
    if isinstance(level, str) and level not in KNOWN_LEVELS:
        notes.append(f"The overall level {level} is not one of the documented levels. It is shown as returned.")
    if level is None:
        notes.append("The API returned no overall level.")
    if cfg["with_evidence"] and "evidence" not in ans:
        notes.append("No evidence was returned for any area.")
    return {
        "firmable_id": c.get("firmable_id"), "company_name": c.get("company_name"), "country": c.get("country"),
        "industry_group": c.get("industry_group"), "size_band": c.get("size_band"),
        "overall_level": level,
        "overall_level_documented": level in KNOWN_LEVELS if isinstance(level, str) else None,
        "explanation": c.get("explanation"),
        "momentum": {"label": momentum.get("label"),
                     "signals": [s for s in (momentum.get("signals") or []) if isinstance(s, dict)]},
        "as_of": c.get("as_of"), "framework_version": c.get("framework_version"),
        "billable": (ans.get("usage") or {}).get("billable") if isinstance(ans.get("usage"), dict) else None,
        "notes": notes,
        "areas": [_area(a, dims.get(a), available.get(a), ans.get("evidence"), cfg, c.get("firmable_id"), names)
                  for a in AREAS],
    }


def _data_notes(row: dict[str, str], subject: dict[str, str], ai: dict[str, Any]) -> list[str]:
    out = []
    fid = _text(ai.get("firmable_id"))
    if subject["type"] == "company_id" and fid and fid != subject["value"]:
        out.append(f"You asked for company ID {subject['value']}; AI Adoption answered with company ID {fid}.")
    a, b = _text(row.get("company_name")), _text(ai.get("company_name"))
    if a and b and a.lower() != b.lower():
        out.append(f"The input names the company \"{a}\"; AI Adoption names it \"{b}\". Both are shown as given.")
    return out


# ----- run -----------------------------------------------------------------------------------------

def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    coverage = [
        "Companies come from your input file. The REST API has no company search.",
        "Levels, explanations, headlines and momentum are shown as returned by the API. This code computes no "
        "score, no trend and no narrative.",
        "Not observed means not observed in retrieved data. It does not mean the company has not adopted AI.",
        "Workforce evidence is checked for a different organisation only in fields the API returns that name an "
        "organisation (company_id, firmable_id, organisation_id, company_name, employer, organisation, company). "
        "The documented workforce item fields do not include an employer, so an item that belongs to another "
        "organisation may not be detectable.",
        "An AI adoption level does not prove buying intent.",
    ]
    if cfg["with_evidence"]:
        coverage.append("AI Adoption checks before reading that your organisation could pay 3 credits for every "
                        "company in a batch. A batch of 25 companies with evidence needs 75 credits available.")
    else:
        coverage.append("Evidence was not requested (with_evidence is false), so the briefs show levels and "
                        "headlines without evidence items.")

    subjects: dict[str, dict[str, str]] = {}
    external_ids: dict[str, str] = {}
    first_row: dict[str, str] = {}
    keys: list[str] = []
    for r in ctx.rows:
        s, _ = subject_of(r)
        if s and _key(s) not in subjects:
            subjects[_key(s)] = s
            external_ids[_key(s)] = r["row_id"]
            first_row[_key(s)] = r["row_id"]
            keys.append(_key(s))
    fetcher = BatchFetcher(ctx, keys, subjects, external_ids, cfg["batch_size"], cfg["with_evidence"])
    row_errors: dict[str, dict[str, Any]] = {}
    dupes = 0

    def one(row: dict[str, str]) -> dict[str, Any]:
        nonlocal dupes
        subject, problem = subject_of(row)
        base: dict[str, Any] = {"row_id": row["row_id"], "input": row, "subject": subject, "duplicate_of": None,
                                "ai_adoption": None, "data_notes": [], "brief_file": None}
        if subject is None:
            return {**base, "status": "invalid_input", "status_reason": problem}
        key = _key(subject)
        if first_row[key] != row["row_id"]:
            base["duplicate_of"] = first_row[key]
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
            err = value.get("error") if isinstance(value.get("error"), dict) else {}
            base["ai_adoption"] = {"error_code": err.get("code"), "error_message": err.get("message"),
                                   "billable": (value.get("usage") or {}).get("billable")
                                   if isinstance(value.get("usage"), dict) else None}
            return {**base, "status": "not_found",
                    "status_reason": "Firmable holds no AI adoption data for this company, or could not match it. "
                                     "This is not a finding of no AI adoption."}
        ai = ai_section(value, cfg)
        base["ai_adoption"] = ai
        base["data_notes"] = _data_notes(row, subject, ai)
        return {**base, "status": "brief_ready",
                "status_reason": f"Overall level {_text(ai.get('overall_level')) or 'not returned'}, as of "
                                 f"{_text(ai.get('as_of')) or 'an unstated date'}."}

    rows = ctx.run_rows(ctx.rows, one)
    _assign_brief_files(rows)

    counts: dict[str, int] = {}
    levels: dict[str, int] = {}
    flagged = 0
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        if r["status"] == "brief_ready" and not r.get("duplicate_of"):
            lv = _text(r["ai_adoption"].get("overall_level")) or "not returned"
            levels[lv] = levels.get(lv, 0) + 1
            if any(a["flags"] for a in r["ai_adoption"]["areas"]):
                flagged += 1
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company; the earlier answer was reused and no brief "
                        "file was written for the repeat.")
    if flagged:
        coverage.append(f"{flagged} brief(s) have missing, truncated or questionable evidence flagged in at least "
                        "one area.")
    if any(r.get("data_notes") for r in rows):
        coverage.append("Some company facts differ between your input and AI Adoption. Both values are shown; "
                        "this code does not correct upstream data.")
    summary = {"companies_in_input": len(rows), "unique_companies_asked": len(keys), "status_counts": counts,
               "overall_level_counts": levels, "briefs_written": len([r for r in rows if r.get("brief_file")
                                                                      and not r.get("duplicate_of")])}
    return {"rows": rows, "summary": summary, "coverage": coverage}


def _assign_brief_files(rows: list[dict[str, Any]]) -> None:
    used: set[str] = set()
    by_row: dict[str, str] = {}
    for r in rows:
        if r["status"] not in ("brief_ready", "not_found") or r.get("duplicate_of"):
            continue
        stem = "ai-brief-" + _SAFE_NAME.sub("_", r["row_id"])
        name = f"{stem}.md"
        n = 2
        while name in used:
            name = f"{stem}-{n}.md"
            n += 1
        used.add(name)
        r["brief_file"] = name
        by_row[r["row_id"]] = name
    for r in rows:
        if r.get("duplicate_of") and r["status"] in ("brief_ready", "not_found"):
            r["brief_file"] = by_row.get(r["duplicate_of"])


# ----- Markdown ------------------------------------------------------------------------------------

def md(value: Any) -> str:
    """Escapes Markdown special characters in API or input text and keeps it on one line."""
    t = _s(value).replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    out = "".join("\\" + ch if ch in _MD_SPECIAL else ch for ch in t)
    return "\\" + out if out.startswith("#") else out


def _mv(value: Any) -> str:
    return "not returned" if value is None or value == "" else md(value)


def _field_text(v: Any) -> str:
    if isinstance(v, list) and all(not isinstance(x, (dict, list)) for x in v):
        return ", ".join(_s(x) for x in v)
    return _s(v)


def item_fields(item: dict[str, Any]) -> str:
    """Every returned field of an evidence item except ref and qualifies, as 'name: value' pairs."""
    parts = [f"{k}: {_field_text(v)}" for k, v in item.items() if k not in ("ref", "qualifies")]
    return "; ".join(parts)


def item_ref(item: dict[str, Any]) -> str:
    ref = item.get("ref") if isinstance(item.get("ref"), dict) else {}
    t, i = _s(ref.get("type")), _s(ref.get("id"))
    return (t + " " + i).strip() or "not returned"


def _items_md(title: str, items: list[dict[str, Any]], total: int) -> list[str]:
    lines = [f"**{title}** ({total} returned, {len(items)} shown)", ""]
    if not items:
        return lines + ["None shown.", ""]
    lines += ["| Reference (`ref`) | Fields as returned |", "| - | - |"]
    lines += [f"| {md(item_ref(i))} | {md(item_fields(i))} |" for i in items]
    return lines + [""]


def brief_markdown(r: dict[str, Any]) -> str:
    ai = r.get("ai_adoption") or {}
    found = r["status"] == "brief_ready"
    name = (ai.get("company_name") if found else None) or r["input"].get("company_name") or r["subject"]["value"]
    s = r["subject"]
    lines = [f"# AI adoption brief: {md(name)}", "",
             "Every fact below is an AI Adoption field as the API returned it, with the field name in brackets. "
             "This brief adds no score, no trend and no narrative.", "",
             "## Company", "", "| Field | Value |", "| - | - |",
             f"| Row | {md(r['row_id'])} |",
             f"| Asked by | {md(s['type'])} {md(s['value'])} |"]
    if r["input"].get("company_name"):
        lines.append(f"| Name in your input | {md(r['input']['company_name'])} |")
    if found:
        for label, field in (("Firmable ID", "firmable_id"), ("Company name", "company_name"), ("Country", "country"),
                             ("Industry group", "industry_group"), ("Size band", "size_band"), ("Data as of", "as_of"),
                             ("Framework version", "framework_version")):
            lines.append(f"| {label} (`{field}`) | {_mv(ai.get(field))} |")
    lines.append("")
    for n in r.get("data_notes") or []:
        lines += [f"Note: {md(n)}", ""]
    if not found:
        lines += ["## AI adoption", "",
                  "Firmable holds no AI adoption data for this company, or could not match it. This is not a finding "
                  "of no AI adoption.", "",
                  f"Error code as returned: {_mv(ai.get('error_code'))}. Message as returned: "
                  f"{_mv(ai.get('error_message'))}.", ""]
        return "\n".join(lines + _reading_md())

    lines += ["## Overall level", "",
              f"- Level (`overall_level`): {_mv(ai.get('overall_level'))}",
              f"- Explanation (`explanation`), as returned: {_mv(ai.get('explanation'))}"]
    lines += [f"- Note: {md(n)}" for n in ai.get("notes") or []]
    m = ai.get("momentum") or {}
    lines += ["", "## Momentum", "", f"- Label (`momentum.label`): {_mv(m.get('label'))}", ""]
    if m.get("signals"):
        lines += ["| Signal kind (`kind`) | Count (`count`) | Latest (`latest`) |", "| - | - | - |"]
        lines += [f"| {_mv(x.get('kind'))} | {_mv(x.get('count'))} | {_mv(x.get('latest'))} |" for x in m["signals"]]
    else:
        lines.append("No momentum signals were returned.")
    lines += ["", "## Areas", "",
              "| Area | Level | Observability | Counts toward overall | Evidence held (`evidence_available`) |",
              "| - | - | - | - | - |"]
    for a in ai["areas"]:
        lines.append(f"| {a['area']} | {_mv(a.get('level'))} | {_mv(a.get('observability'))} | "
                     f"{_mv(a.get('counts_toward_overall'))} | {_mv(a.get('evidence_available'))} |")
    lines.append("")
    for a in ai["areas"]:
        lines += _area_md(a)
    lines += ["## Not observed", ""]
    missing = [a for a in ai["areas"] if (a.get("evidence") or {}).get("status") == "not_returned"
               or not a.get("level")]
    if (ai["areas"] and ai["areas"][0]["evidence"]["status"] == "not_requested"):
        lines.append("Evidence was not requested for this run, so this brief cannot say which areas have evidence.")
    elif missing:
        for a in missing:
            what = "the API returned no level" if not a.get("level") else "no evidence was returned"
            lines.append(f"- {a['area']}: {what}. Not observed in retrieved data; this does not mean the company "
                         "has no AI activity in this area.")
    else:
        lines.append("Every area returned a level and evidence.")
    lines.append("")
    return "\n".join(lines + _reading_md())


def _area_md(a: dict[str, Any]) -> list[str]:
    ev = a.get("evidence") or {}
    lines = [f"### {a['area'].capitalize()}", "",
             f"- Level (`level`): {_mv(a.get('level'))}",
             f"- Headline (`headline`), as returned: {_mv(a.get('headline'))}",
             f"- Observability (`observability`): {_mv(a.get('observability'))}",
             f"- Counts toward overall (`counts_toward_overall`): {_mv(a.get('counts_toward_overall'))}",
             f"- Evidence held (`evidence_available`): {_mv(a.get('evidence_available'))}"]
    if ev.get("status") == "returned":
        lines.append(f"- Evidence returned: {ev['items_returned']} of {_mv(ev.get('item_count'))} item(s) "
                     f"(`item_count`), as of {_mv(ev.get('as_of'))}, truncated: {_s(ev.get('truncated'))}")
    elif ev.get("status") == "not_returned":
        lines.append("- Evidence returned: none")
    else:
        lines.append("- Evidence returned: not requested")
    for f in a["flags"]:
        lines.append(f"- Flag: {md(f)}")
    for n in a["notes"]:
        lines.append(f"- Note: {md(n)}")
    lines.append("")
    if ev.get("status") == "returned":
        lines += _items_md("Qualifying evidence (`qualifies` true)", ev["qualifying"], ev["qualifying_count"])
        lines += _items_md("Evidence that does not qualify (`qualifies` false)", ev["not_qualifying"],
                           ev["not_qualifying_count"])
        if ev["unstated_count"]:
            lines += _items_md("Evidence that does not say whether it qualifies", ev["qualification_unstated"],
                               ev["unstated_count"])
    return lines


def _reading_md() -> list[str]:
    return ["## How to read this brief", "",
            "- Levels, explanations and headlines are the API's own words. They are not rewritten.",
            "- Qualifying evidence counts towards an area's level. Evidence that does not qualify was found but "
            "does not count.",
            "- Not observed means not observed in retrieved data. It does not mean the company has not adopted AI.",
            "- An AI adoption level does not prove buying intent.", ""]


def markdown(result: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for r in result["rows"]:
        if r.get("brief_file") and not r.get("duplicate_of"):
            out[r["brief_file"]] = brief_markdown(r)
    return out


# ----- CSV and report ------------------------------------------------------------------------------

CSV_COLUMNS = ["row_id", "asked_by", "asked_value", "duplicate_of", "status", "status_reason", "firmable_id",
               "company_name", "overall_level", "momentum_label", "architecture_level", "footprint_level",
               "hiring_level", "initiatives_level", "workforce_level", "evidence_items_returned",
               "truncated_areas", "flags", "as_of", "brief_file"]


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        ai = r.get("ai_adoption") or {}
        areas = {a["area"]: a for a in ai.get("areas") or []}
        subject = r.get("subject") or {}
        flags = list(r.get("data_notes") or [])
        for a in ai.get("areas") or []:
            flags += [f"{a['area']}: {f}" for f in a["flags"]]
        returned = [a["evidence"].get("items_returned") for a in ai.get("areas") or []
                    if a["evidence"].get("status") == "returned"]
        row = {"row_id": r["row_id"], "asked_by": subject.get("type"),
               "asked_value": subject.get("value") or r["input"].get("company_id") or r["input"].get("domain"),
               "duplicate_of": r.get("duplicate_of"), "status": r["status"],
               "status_reason": r.get("status_reason") or r.get("reason"),
               "firmable_id": ai.get("firmable_id"), "company_name": ai.get("company_name"),
               "overall_level": ai.get("overall_level"), "momentum_label": (ai.get("momentum") or {}).get("label"),
               "evidence_items_returned": sum(returned) if returned else None,
               "truncated_areas": [a["area"] for a in ai.get("areas") or [] if a["evidence"].get("truncated")],
               "flags": flags, "as_of": ai.get("as_of"), "brief_file": r.get("brief_file")}
        for a in AREAS:
            row[f"{a}_level"] = (areas.get(a) or {}).get("level")
        out.append(row)
    return out


def _items_table(items: list[dict[str, Any]]) -> str:
    return table(["Reference", "Fields as returned"], [[item_ref(i), item_fields(i)] for i in items])


def _area_html(a: dict[str, Any]) -> str:
    html = f"<h3>{esc(a['area'].capitalize())}: {esc(a.get('level') or 'no level returned')}</h3>"
    html += f"<p>{esc(a.get('headline'))}</p>" if a.get("headline") else "<p class=\"muted\">No headline returned.</p>"
    for f in a["flags"]:
        html += note(esc(f), "review")
    for n in a["notes"]:
        html += note(esc(n), "unknown")
    ev = a.get("evidence") or {}
    if ev.get("status") == "returned":
        html += (f"<p class=\"muted\">Evidence as of {esc(ev.get('as_of'))}: {esc(ev.get('items_returned'))} of "
                 f"{esc(_s(ev.get('item_count')))} item(s) returned" + (", truncated" if ev.get("truncated") else "")
                 + ".</p>")
        if ev["qualifying"]:
            html += f"<p><strong>Qualifying evidence</strong> ({ev['qualifying_count']} returned)</p>" + _items_table(ev["qualifying"])
        if ev["not_qualifying"]:
            html += (f"<p><strong>Evidence that does not qualify</strong> ({ev['not_qualifying_count']} returned)</p>"
                     + _items_table(ev["not_qualifying"]))
        if ev["qualification_unstated"]:
            html += ("<p><strong>Evidence that does not say whether it qualifies</strong></p>"
                     + _items_table(ev["qualification_unstated"]))
    return html


def render(report: Any, result: dict[str, Any]) -> None:
    counts = result["summary"].get("status_counts", {})
    report.add("Result", "Brief summary",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                                for k, v in counts.items()) + "</p>"
               + note("Levels, explanations and headlines are the API's own words. This report computes no score "
                      "and no trend. Not observed means not observed in retrieved data, not no adoption.", "unknown"))
    cards = []
    for r in result["rows"]:
        status = r["status"]
        ai = r.get("ai_adoption") or {}
        subject = r.get("subject") or {}
        title = ai.get("company_name") or r["input"].get("company_name") or subject.get("value") or r["row_id"]
        reason = r.get("status_reason") or r.get("reason") or ""
        left = f"<p>{esc(reason)}</p>"
        if subject:
            left += kv([("Asked by", f"{subject.get('type')} {subject.get('value')}"), ("Brief file", r.get("brief_file"))])
        if r.get("duplicate_of"):
            left += note(f"Same company as row {esc(r['duplicate_of'])}; the answer was reused.", "info")
        for n in r.get("data_notes") or []:
            left += note(esc(n), "review")
        right = ""
        if status == "brief_ready":
            m = ai.get("momentum") or {}
            left += "<h3>AI Adoption</h3>" + kv([
                ("Firmable ID", ai.get("firmable_id")), ("Country", ai.get("country")),
                ("Industry group", ai.get("industry_group")), ("Size band", ai.get("size_band")),
                ("Overall level", ai.get("overall_level")), ("Explanation", ai.get("explanation")),
                ("Momentum", m.get("label")),
                ("Momentum signals", "; ".join(f"{_s(s.get('kind'))}: {_s(s.get('count'))}, latest {_s(s.get('latest'))}"
                                               for s in m.get("signals") or []) or None),
                ("Data as of", ai.get("as_of")), ("Framework version", ai.get("framework_version"))])
            for n in ai.get("notes") or []:
                left += note(esc(n), "unknown")
            right += table(["Area", "Level", "Observability", "Counts toward overall", "Evidence held", "Flags"], [
                [a["area"], a.get("level"), a.get("observability"), a.get("counts_toward_overall"),
                 _s(a.get("evidence_available")), len(a["flags"])] for a in ai["areas"]])
            right += "".join(_area_html(a) for a in ai["areas"])
            right += details_json("Area detail as returned", {a["area"]: a["detail"] for a in ai["areas"]})
        elif status == "not_found":
            left += note("Firmable holds no AI adoption data for this company, or could not match it. This is not a "
                         "finding of no AI adoption.", "unknown")
        cards.append(card(str(title), badge(status.replace("_", " "), STATUS_TONE.get(status, "neutral")), left,
                          right or "<p class=\"muted\">No evidence to show for this row.</p>", sub=f"Row {r['row_id']}"))
    report.add("Companies", "Each company brief", "".join(cards))
    report.add("Reading the briefs", "How to read the briefs", bullet_list([
        Raw(esc(line[2:])) for line in _reading_md()[2:-1]]))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render,
                markdown=markdown)
