"""AI adoption landscape: how far a cohort of companies you supply has adopted AI, and on what evidence.

Workflow:
1. Read each row's company: `company_id` when given, otherwise the normalised `domain`. Rows that
   repeat a company reuse its answer. Invalid rows are reported and not sent.
2. Send the unique companies to POST /ai-adoption in `records` batches of up to `batch_size`.
3. Count, for the whole cohort and for each group, the overall level, each area's level and
   observability, and the momentum label.

Measurement rules:
- A company is counted once per group. Rows that resolve to the same Firmable company are one company.
- A share is a count over the companies with a value returned, and the denominator is kept with it.
- Companies not found, and areas with no level returned, are counted as "no value" beside the share.
  They are never counted as no adoption.
- Levels are kept as returned. The docs list levels but define no ranking, so nothing is ranked or scored.
- A measure with fewer answered companies than `min_answered` is marked too few answers to compare.
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError, FirmableError, InvalidResponseError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, details_json, esc, kv, note, table

NAME = "adoption-landscape"
TITLE = "AI adoption landscape"
DESCRIPTION = ("Shows how far a cohort of companies you supply has adopted AI: overall level, each area's level "
               "and observability, and momentum, per group, from the Firmable AI Adoption API.")

DIMENSIONS = ["architecture", "footprint", "hiring", "initiatives", "workforce"]
# The order the API docs list these values in. It is used for display only and is not a ranking.
LEVEL_ORDER = ["NONE", "BASIC", "MEANINGFUL", "MODERATE", "STRONG", "ADVANCED"]
OBSERVABILITY_ORDER = ["LOW", "MEDIUM", "HIGH"]
RESPONSE_GROUPS = ["industry_group", "size_band", "country"]
STATUSES = ["found", "not_found", "error", "not_processed", "invalid_input"]
NOT_RETURNED = "(not returned)"
BLANK = "(blank)"
COHORT = "All companies"
STATUS_TONE = {"found": "good", "not_found": "unknown", "error": "error", "not_processed": "unknown",
               "invalid_input": "error"}
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TOP_KEYS = {"batch_size", "with_evidence", "group_by", "min_answered"}
ENDPOINT = "POST /ai-adoption"
EXPLORER_JS = Path(__file__).resolve().parents[3] / "assets" / "explorer.js"


# ----- configuration --------------------------------------------------------------------------

def _whole(v: Any, minimum: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= minimum


def load_config(raw: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(raw) - _TOP_KEYS)
    if unknown:
        raise ConfigError(f"Unknown configuration key(s): {', '.join(unknown)}")
    batch_size = raw.get("batch_size", 100)
    if not _whole(batch_size, 1) or batch_size > 100:
        raise ConfigError("batch_size must be a whole number from 1 to 100.")
    with_evidence = raw.get("with_evidence", False)
    if not isinstance(with_evidence, bool):
        raise ConfigError("with_evidence must be true or false.")
    group_by = raw.get("group_by")
    if group_by is not None and (not isinstance(group_by, str) or not group_by.strip() or group_by == "row_id"):
        raise ConfigError("group_by must be null, an input column name, or one of: "
                          f"{', '.join(RESPONSE_GROUPS)}.")
    min_answered = raw.get("min_answered", 5)
    if not _whole(min_answered, 1):
        raise ConfigError("min_answered must be a whole number, 1 or more.")
    return {"batch_size": batch_size, "with_evidence": with_evidence,
            "group_by": group_by.strip() if isinstance(group_by, str) else None, "min_answered": min_answered}


def read_input(path: Path) -> list[dict[str, str]]:
    return read_rows(path, any_of=["domain", "company_id"])


# ----- subjects and batching ------------------------------------------------------------------

def subject_of(row: dict[str, str]) -> dict[str, Any]:
    """The company a row asks about: company_id when given, else the normalised domain."""
    cid = (row.get("company_id") or "").strip()
    if cid:
        if _COMPANY_ID.match(cid):
            return {"kind": "company_id", "value": cid, "key": f"company_id:{cid}", "reason": None}
        return {"kind": None, "value": None, "key": None,
                "reason": f"{cid!r} is not a valid Firmable company ID."}
    domain = normalise_domain(row.get("domain"))
    if domain:
        return {"kind": "domain", "value": domain, "key": f"domain:{domain}", "reason": None}
    return {"kind": None, "value": None, "key": None, "reason": f"{row.get('domain')!r} is not a valid domain."}


def unique_subjects(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        s = subject_of(r)
        if s["key"] and s["key"] not in seen:
            seen.add(s["key"])
            out.append({**s, "row_id": r["row_id"], "external_id": r["row_id"][:200]})
    return out


def plan(rows: list[dict[str, str]], config: dict[str, Any]) -> list[PlannedCall]:
    n = len(unique_subjects(rows))
    b = config["batch_size"]
    return [PlannedCall(ENDPOINT, f"AI Adoption for {n} unique valid company(ies) in batches of up to {b}"
                        + (", with evidence" if config["with_evidence"] else ""), math.ceil(n / b),
                        pricing.estimate_ai_adoption(n, config["with_evidence"]))]


def fetch_all(ctx: RunContext, subjects: list[dict[str, Any]], batch_size: int,
              with_evidence: bool) -> dict[str, dict[str, Any]]:
    """Sends the subjects in batches and returns an outcome per subject key.

    Outcome states: found, not_found, error, not_processed. A failed batch is an error for every
    company in it. A fatal error stops later batches, which are not_processed.
    """
    out: dict[str, dict[str, Any]] = {}
    for start in range(0, len(subjects), batch_size):
        batch = subjects[start:start + batch_size]
        if ctx.stopped is not None:
            for s in batch:
                out[s["key"]] = {"state": "not_processed", "reason": f"Run stopped earlier: {ctx.stopped['message']}"}
            continue
        records = [{s["kind"]: s["value"], "external_id": s["external_id"]} for s in batch]
        try:
            resp = ctx.client.get_ai_adoption({"records": records}, with_evidence=with_evidence)
        except FirmableError as e:
            entry = ctx.record_error(None, e)
            for s in batch:
                out[s["key"]] = {"state": "error", "error": entry}
            continue
        results = resp.get("results")
        if not isinstance(results, list) or len(results) != len(batch):
            count = len(results) if isinstance(results, list) else 0
            ctx.client.budget.mark_uncertain()
            entry = ctx.record_error(None, InvalidResponseError(
                f"The AI Adoption batch response has {count} result(s) for {len(batch)} company(ies) sent.",
                status=200, endpoint=ENDPOINT, charge_uncertain=True))
            for s in batch:
                out[s["key"]] = {"state": "error", "error": entry}
            continue
        for i, (s, r) in enumerate(zip(batch, results), start=1):
            out[s["key"]] = _classify(ctx, s, r, i)
    return out


def _answer_error(row_id: str, kind: str, code: Any, message: str) -> dict[str, Any]:
    return {"row_id": row_id, "kind": kind, "status": 200, "code": code, "endpoint": ENDPOINT,
            "message": message, "charge_uncertain": False, "retry_after": None}


def _classify(ctx: RunContext, s: dict[str, Any], r: Any, position: int) -> dict[str, Any]:
    if not isinstance(r, dict):
        entry = _answer_error(s["row_id"], "invalid_response", None,
                              f"The answer in position {position} is not a JSON object.")
        ctx.errors.append(entry)
        return {"state": "error", "error": entry}
    inp = r.get("input") if isinstance(r.get("input"), dict) else {}
    echoed = inp.get("external_id")
    if echoed is not None and echoed != s["external_id"]:
        entry = _answer_error(s["row_id"], "invalid_response", None,
                              f"The answer in position {position} carries external_id {echoed}, but "
                              f"{s['external_id']} was sent there.")
        ctx.errors.append(entry)
        return {"state": "error", "error": entry}
    comp = r.get("company")
    err = r.get("error") if isinstance(r.get("error"), dict) else None
    if isinstance(comp, dict):
        return {"state": "found", "response": r}
    if err is None or err.get("code") == "not_found":
        return {"state": "not_found", "response": r, "message": (err or {}).get("message")}
    entry = _answer_error(s["row_id"], "answer_error", err.get("code"),
                          str(err.get("message") or err.get("code") or "error"))
    ctx.errors.append(entry)
    return {"state": "error", "error": entry}


def ai_summary(comp: dict[str, Any]) -> dict[str, Any]:
    mom = comp.get("momentum") if isinstance(comp.get("momentum"), dict) else {}
    dims = comp.get("dimensions") if isinstance(comp.get("dimensions"), dict) else {}
    return {
        "firmable_id": comp.get("firmable_id"), "company_name": comp.get("company_name"),
        "country": comp.get("country"), "industry_group": comp.get("industry_group"),
        "size_band": comp.get("size_band"), "overall_level": comp.get("overall_level"),
        "explanation": comp.get("explanation"), "momentum_label": mom.get("label"),
        "momentum_signals": [x for x in (mom.get("signals") or []) if isinstance(x, dict)],
        "dimensions": {d: ({k: dims[d].get(k) for k in ("level", "headline", "observability", "counts_toward_overall")}
                           if isinstance(dims.get(d), dict) else None) for d in DIMENSIONS},
        "evidence_available": comp.get("evidence_available") if isinstance(comp.get("evidence_available"), dict) else None,
        "as_of": comp.get("as_of"), "framework_version": comp.get("framework_version"),
    }


def evidence_summary(evidence: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not isinstance(evidence, dict):
        return out
    for area in DIMENSIONS:
        e = evidence.get(area)
        if not isinstance(e, dict):
            continue
        items = [i for i in (e.get("items") or []) if isinstance(i, dict)]
        out[area] = {"item_count": e.get("item_count"), "items_returned": len(items),
                     "qualifying": sum(1 for i in items if i.get("qualifies") is True),
                     "not_qualifying": sum(1 for i in items if i.get("qualifies") is False),
                     "truncated": e.get("truncated") is True, "as_of": e.get("as_of")}
    return out


# ----- measures -------------------------------------------------------------------------------

def pct(n: int, d: int) -> float | None:
    """n over d as a percentage, one decimal place, rounded half up, identically in both languages."""
    if d == 0:
        return None
    return math.floor(n * 1000 / d + 0.5) / 10


def pct_text(v: float | None) -> str:
    if v is None:
        return "-"
    return str(int(v)) if float(v).is_integer() else str(v)


def distribution(values: list[Any], order: list[str], not_found: int, min_answered: int) -> dict[str, Any]:
    answered = [v for v in values if isinstance(v, str) and v]
    counts: dict[str, int] = {}
    for v in answered:
        counts[v] = counts.get(v, 0) + 1
    keys = [k for k in order if k in counts] + sorted(k for k in counts if k not in order)
    n = len(answered)
    no_value = not_found + len(values) - n
    too_few = n < min_answered
    return {"answered": n, "no_value": no_value, "no_value_share_pct": pct(no_value, len(values) + not_found),
            "too_few_answers": too_few,
            "values": [{"value": k, "count": counts[k], "share_pct": None if too_few else pct(counts[k], n)}
                       for k in keys]}


def measure_block(label: str, units: list[dict[str, Any]], min_answered: int) -> dict[str, Any]:
    c = {s: 0 for s in STATUSES}
    for u in units:
        c[u["status"]] += 1
    found = [u["ai_adoption"] for u in units if u["status"] == "found"]
    nf = c["not_found"]
    dims: dict[str, Any] = {}
    for d in DIMENSIONS:
        areas = [a["dimensions"].get(d) or {} for a in found]
        dims[d] = {"level": distribution([x.get("level") for x in areas], LEVEL_ORDER, nf, min_answered),
                   "observability": distribution([x.get("observability") for x in areas], OBSERVABILITY_ORDER,
                                                 nf, min_answered)}
    return {"group": label, "companies": len(units), "asked": c["found"] + c["not_found"] + c["error"], **c,
            "overall_level": distribution([a["overall_level"] for a in found], LEVEL_ORDER, nf, min_answered),
            "momentum": distribution([a["momentum_label"] for a in found], [], nf, min_answered),
            "dimensions": dims}


def group_value(row: dict[str, Any], group_by: str | None) -> str | None:
    if group_by is None:
        return None
    if group_by in RESPONSE_GROUPS:
        v = (row.get("ai_adoption") or {}).get(group_by)
        return v if isinstance(v, str) and v else NOT_RETURNED
    v = row["input"].get(group_by) or ""
    return v if v else BLANK


def _group_sort(labels: list[str]) -> list[str]:
    special = [x for x in (NOT_RETURNED, BLANK) if x in labels]
    return sorted(x for x in labels if x not in special) + special


def unit_id(row: dict[str, Any]) -> str:
    ai = row.get("ai_adoption") or {}
    if row["status"] == "found" and isinstance(ai.get("firmable_id"), str) and ai["firmable_id"]:
        return f"firmable:{ai['firmable_id']}"
    return row.get("subject_key") or f"invalid:{row['row_id']}"


# ----- run ------------------------------------------------------------------------------------

def build_rows(ctx: RunContext, outcomes: dict[str, dict[str, Any]], with_evidence: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    first_by_key: dict[str, str] = {}
    first_by_firmable: dict[str, tuple[str, str]] = {}
    for r in ctx.rows:
        s = subject_of(r)
        base: dict[str, Any] = {"row_id": r["row_id"], "input": r, "subject_kind": s["kind"],
                                "subject": s["value"], "subject_key": s["key"], "duplicate_of": None,
                                "same_company_as": None, "group": None, "ai_adoption": None,
                                "evidence_summary": None, "api_message": None, "error": None}
        if s["key"] is None:
            rows.append({**base, "status": "invalid_input", "status_reason": s["reason"]})
            continue
        if s["key"] in first_by_key:
            base["duplicate_of"] = first_by_key[s["key"]]
        else:
            first_by_key[s["key"]] = r["row_id"]
        o = outcomes.get(s["key"]) or {"state": "not_processed", "reason": "This company was not sent."}
        state = o["state"]
        if state == "found":
            comp = o["response"]["company"]
            ai = ai_summary(comp)
            base["ai_adoption"] = ai
            if with_evidence:
                base["evidence_summary"] = evidence_summary(o["response"].get("evidence"))
            fid = ai.get("firmable_id")
            if isinstance(fid, str) and fid:
                prev = first_by_firmable.get(fid)
                if prev is not None and prev[1] != s["key"]:
                    base["same_company_as"] = prev[0]
                elif prev is None:
                    first_by_firmable[fid] = (r["row_id"], s["key"])
            level = ai.get("overall_level")
            reason = (f"Found. Overall level {level} as returned." if isinstance(level, str) and level
                      else "Found. No overall level was returned.")
            rows.append({**base, "status": "found", "status_reason": reason})
        elif state == "not_found":
            base["api_message"] = o.get("message")
            rows.append({**base, "status": "not_found",
                         "status_reason": "Firmable has no AI Adoption data for this company (not found). This is "
                                          "not evidence of no adoption."})
        elif state == "error":
            rows.append({**base, "status": "error", "error": o["error"],
                         "status_reason": f"No answer because of an error: {str(o['error']['message']).rstrip('.')}."})
        else:
            rows.append({**base, "status": "not_processed", "status_reason": o["reason"]})
    return rows


def compute(rows: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    """The cohort block and one block per group. Each company counts once per group."""
    group_by = config["group_by"]
    min_answered = config["min_answered"]
    for r in rows:
        r["group"] = group_value(r, group_by)
    cohort_units: dict[str, dict[str, Any]] = {}
    groups: dict[str, dict[str, dict[str, Any]]] = {}
    for r in rows:
        uid = unit_id(r)
        cohort_units.setdefault(uid, r)
        if group_by is not None:
            groups.setdefault(r["group"], {}).setdefault(uid, r)
    cohort = measure_block(COHORT, list(cohort_units.values()), min_answered)
    blocks = [measure_block(g, list(groups[g].values()), min_answered) for g in _group_sort(list(groups))]
    return {"cohort": cohort, "groups": blocks}


def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    subjects = unique_subjects(ctx.rows)
    outcomes = fetch_all(ctx, subjects, cfg["batch_size"], cfg["with_evidence"])
    rows = build_rows(ctx, outcomes, cfg["with_evidence"])
    measures = compute(rows, cfg)

    coverage = [
        "The cohort is the list of companies you supplied. The REST API has no general company search, so these "
        "measures describe this cohort only, not a market, sector or population.",
        "Each share is a count over the companies in the group with a value returned, and the denominator is shown "
        "with it.",
        "Companies not found, and areas with no level returned, are counted as no value beside each share. They are "
        "never counted as no adoption.",
        "Levels are shown as returned. The API docs list levels such as NONE, BASIC, MEANINGFUL, MODERATE, STRONG and "
        "ADVANCED but define no ranking, so this recipe does not rank or score them.",
        f"A measure with fewer than {cfg['min_answered']} answered companies is marked too few answers to compare, "
        "and no share is shown for it.",
        "An AI adoption level or a momentum label does not prove buying intent.",
        "AI Adoption explanations, headlines and momentum signals are shown as returned.",
    ]
    if cfg["group_by"] is not None:
        if cfg["group_by"] in RESPONSE_GROUPS:
            coverage.append(f"Groups come from the {cfg['group_by']} field of each AI Adoption answer. Companies "
                            f"without an answer are in the group {NOT_RETURNED}.")
        elif not any(cfg["group_by"] in r for r in ctx.rows):
            coverage.append(f"The input file has no column {cfg['group_by']}, so every company is in the group "
                            f"{BLANK}.")
        else:
            coverage.append(f"Groups come from the input column {cfg['group_by']}. A company whose rows carry "
                            "different values counts once in each of those groups.")
    if cfg["with_evidence"]:
        coverage.append("Evidence items with qualifies false are counted separately; they do not count towards a "
                        "level. Evidence is summarised as returned.")
        coverage.append("The response does not say which organisation each evidence item belongs to beyond its "
                        "ref, so evidence that belongs to a different organisation cannot be detected here.")
    dupes = sum(1 for r in rows if r.get("duplicate_of"))
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company; its answer was reused, not requested again, and "
                        "it is counted once.")
    same = sum(1 for r in rows if r.get("same_company_as"))
    if same:
        coverage.append(f"{same} row(s) resolve to the same Firmable company as an earlier row with a different "
                        "identifier. They are counted once.")
    firsts = [r for r in rows if not r.get("duplicate_of") and not r.get("same_company_as")]
    nf = sum(1 for r in firsts if r["status"] == "not_found")
    if nf:
        coverage.append(f"{nf} company(ies) have no AI Adoption data in Firmable (not found). This means no data was "
                        "retrieved, not that the company has no AI adoption.")
    invalid = sum(1 for r in rows if r["status"] == "invalid_input")
    if invalid:
        coverage.append(f"{invalid} row(s) have no valid domain or company ID and were not sent.")
    found_ai = [r["ai_adoption"] for r in firsts if r["status"] == "found"]
    unfamiliar = sorted({v for a in found_ai
                         for v in [a.get("overall_level")] + [(a["dimensions"].get(d) or {}).get("level")
                                                             for d in DIMENSIONS]
                         if isinstance(v, str) and v and v not in LEVEL_ORDER})
    if unfamiliar:
        coverage.append(f"AI Adoption returned level(s) the docs do not list: {', '.join(unfamiliar)}. They are kept "
                        "as their own values.")
    versions = sorted({a["framework_version"] for a in found_ai if isinstance(a.get("framework_version"), str)})
    if len(versions) > 1:
        coverage.append(f"Answers come from more than one framework version: {', '.join(versions)}. Levels from "
                        "different versions may not be comparable.")
    low = sum(1 for a in found_ai for d in DIMENSIONS if (a["dimensions"].get(d) or {}).get("observability") == "LOW")
    if low:
        coverage.append(f"{low} area result(s) have LOW observability: Firmable can see little of that area for the "
                        "company. Read those levels with that in mind.")
    truncated = sum(1 for r in firsts for e in (r.get("evidence_summary") or {}).values() if e.get("truncated"))
    if truncated:
        coverage.append(f"{truncated} evidence area(s) are truncated: the response holds fewer items than "
                        "item_count.")

    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    dates = sorted(a["as_of"] for a in found_ai if isinstance(a.get("as_of"), str) and a["as_of"])
    summary = {"status_counts": counts, "group_by": cfg["group_by"], "min_answered": cfg["min_answered"],
               "cohort": measures["cohort"], "groups": measures["groups"], "unfamiliar_levels": unfamiliar,
               "framework_versions": versions, "as_of_earliest": dates[0] if dates else None,
               "as_of_latest": dates[-1] if dates else None}
    return {"rows": rows, "summary": summary, "coverage": coverage}


# ----- output ---------------------------------------------------------------------------------

CSV_COLUMNS = (["row_id", "domain", "company_id", "duplicate_of", "same_company_as", "group", "status",
                "status_reason", "firmable_id", "company_name", "country", "industry_group", "size_band",
                "overall_level", "momentum"]
               + [f"{d}_level" for d in DIMENSIONS] + [f"{d}_observability" for d in DIMENSIONS]
               + ["as_of", "framework_version"])


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        ai = r.get("ai_adoption") or {}
        dims = ai.get("dimensions") or {}
        inp = r.get("input") or {}
        row = {"row_id": r["row_id"], "domain": inp.get("domain"), "company_id": inp.get("company_id"),
               "duplicate_of": r.get("duplicate_of"), "same_company_as": r.get("same_company_as"),
               "group": r.get("group"), "status": r["status"],
               "status_reason": r.get("status_reason") or r.get("reason"),
               "firmable_id": ai.get("firmable_id"), "company_name": ai.get("company_name"),
               "country": ai.get("country"), "industry_group": ai.get("industry_group"),
               "size_band": ai.get("size_band"), "overall_level": ai.get("overall_level"),
               "momentum": ai.get("momentum_label"), "as_of": ai.get("as_of"),
               "framework_version": ai.get("framework_version")}
        for d in DIMENSIONS:
            row[f"{d}_level"] = (dims.get(d) or {}).get("level")
            row[f"{d}_observability"] = (dims.get(d) or {}).get("observability")
        out.append(row)
    return out


def explorer_data(result: dict[str, Any]) -> dict[str, Any]:
    s = result["summary"]
    companies = []
    for r in result["rows"]:
        if r.get("duplicate_of"):
            continue
        ai = r.get("ai_adoption") or {}
        companies.append({
            "row_id": r["row_id"], "name": ai.get("company_name") or r.get("subject") or r["input"].get("domain")
            or r["input"].get("company_id") or r["row_id"],
            "subject": r.get("subject"), "group": r.get("group"), "status": r["status"],
            "status_reason": r.get("status_reason"), "same_company_as": r.get("same_company_as"),
            "ai": r.get("ai_adoption"), "evidence": r.get("evidence_summary")})
    return {"group_by": s.get("group_by"), "min_answered": s.get("min_answered"), "dimensions": DIMENSIONS,
            "cohort": s.get("cohort"), "groups": s.get("groups") or [], "companies": companies}


def _dist_text(dist: dict[str, Any]) -> str:
    if not dist["values"]:
        return "no value returned"
    if dist["too_few_answers"]:
        return "; ".join(f"{v['value']} {v['count']}" for v in dist["values"]) + f" (of {dist['answered']}, too few answers to compare)"
    return "; ".join(f"{v['value']} {v['count']} of {dist['answered']} ({pct_text(v['share_pct'])}%)"
                     for v in dist["values"])


def _block_row(b: dict[str, Any]) -> list[Any]:
    d = b["overall_level"]
    return [b["group"], b["companies"], b["asked"], b["found"], b["not_found"], b["error"],
            b["not_processed"] + b["invalid_input"], _dist_text(d),
            f"{d['no_value']} ({pct_text(d['no_value_share_pct'])}%)"]


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    cohort = s.get("cohort")
    if not cohort:
        return
    report.add("Result", "Cohort at a glance",
               "<p>" + " ".join(badge(f"{k.replace('_', ' ')}: {v}", STATUS_TONE.get(k, "neutral"))
                                for k, v in (s.get("status_counts") or {}).items()) + "</p>"
               + kv([("Companies in the cohort", cohort["companies"]), ("Companies asked", cohort["asked"]),
                     ("Found", cohort["found"]), ("Not found", cohort["not_found"]), ("Error", cohort["error"]),
                     ("Not processed", cohort["not_processed"]), ("Invalid input", cohort["invalid_input"]),
                     ("Data as of", f"{s.get('as_of_earliest') or '-'} to {s.get('as_of_latest') or '-'}"),
                     ("Framework versions", ", ".join(s.get("framework_versions") or []))])
               + note("These counts describe <strong>this cohort only</strong>, the companies you supplied. Not "
                      "found is not no adoption. Levels are shown as returned and are not ranked.", "unknown"))

    report.add("Explorer", "Explore the cohort",
               '<style>.ex-controls{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 12px}'
               '.ex-controls label{display:flex;flex-direction:column;font-size:13px;color:var(--muted);min-width:0}'
               '.ex-controls select{font:inherit;padding:4px 6px;max-width:100%}'
               '.ex-bar{display:grid;grid-template-columns:minmax(0,9em) minmax(0,1fr) minmax(0,9em);gap:8px;'
               'align-items:center;margin:4px 0;font-size:14px}'
               '.ex-track{background:var(--shale);border-radius:6px;height:12px;overflow:hidden}'
               '.ex-fill{background:var(--ember);height:12px}'
               '.ex-list button{font:inherit;background:none;border:0;color:var(--deep);text-decoration:underline;'
               'cursor:pointer;padding:0;text-align:left}'
               '.ex-panel{border:1px solid var(--shale);border-radius:12px;padding:12px 14px;margin:10px 0}'
               '@media (max-width:480px){.ex-bar{grid-template-columns:minmax(0,1fr)}}</style>'
               '<div id="explorer"><p class="muted">The explorer needs JavaScript. The same figures are in the '
               'tables below.</p></div>')
    report.add_data("explorer-data", explorer_data(result))
    report.add_script(EXPLORER_JS.read_text(encoding="utf-8"))

    headers = ["Group", "Companies", "Asked", "Found", "Not found", "Error", "Not sent", "Overall level",
               "No value"]
    groups = s.get("groups") or []
    body = table(headers, [_block_row(cohort)] + [_block_row(g) for g in groups])
    if s.get("group_by"):
        body = f"<p>Grouped by <strong>{esc(s['group_by'])}</strong>.</p>" + body
    report.add("Levels", "Overall level by group", body + "<p class=\"muted\">Each share is over the companies "
               "with a level returned. No value counts companies not found and companies with no level returned."
               "</p>")

    area_rows = []
    for d in DIMENSIONS:
        b = cohort["dimensions"][d]
        area_rows.append([d, _dist_text(b["level"]), _dist_text(b["observability"]),
                          f"{b['level']['no_value']} ({pct_text(b['level']['no_value_share_pct'])}%)"])
    area_rows.append(["momentum", _dist_text(cohort["momentum"]), "-",
                      f"{cohort['momentum']['no_value']} ({pct_text(cohort['momentum']['no_value_share_pct'])}%)"])
    report.add("Areas", "Areas and momentum across the cohort",
               table(["Area", "Level", "Observability", "No value"], area_rows))

    comp_rows = []
    for r in result["rows"]:
        ai = r.get("ai_adoption") or {}
        name = ai.get("company_name") or r.get("subject") or r["input"].get("domain") or r["input"].get("company_id")
        flags = []
        if r.get("duplicate_of"):
            flags.append(f"same input as {r['duplicate_of']}")
        if r.get("same_company_as"):
            flags.append(f"same Firmable company as {r['same_company_as']}")
        comp_rows.append([r["row_id"], name, Raw(badge(r["status"].replace("_", " "),
                                                       STATUS_TONE.get(r["status"], "neutral"))),
                          r.get("group"), ai.get("overall_level"), ai.get("momentum_label"), ai.get("explanation"),
                          ai.get("as_of"), "; ".join(flags) or r.get("status_reason")])
    report.add("Companies", "Each company as returned",
               table(["Row", "Company", "Status", "Group", "Overall level", "Momentum", "Explanation", "As of",
                      "Note"], comp_rows)
               + details_json("Measures as JSON", {"cohort": cohort, "groups": groups}))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render)
