"""Peer comparison: how one company's AI adoption compares with a peer cohort you define.

Workflow:
1. Read the input. Exactly one row has role focus; the others have role peer.
2. Send every unique company to POST /ai-adoption in `records` batches of up to `batch_size`.
3. For the overall level, each area's level and the momentum label, put the focus company's value
   beside the peers' distribution, with counts and denominators.

Comparison rules:
- Levels are kept as returned. The docs define no ranking, so a peer is only "same" or "different".
- The placement reads "Same level as n of m peers with data". m counts peers with a value returned.
- Peers not found, and areas with no level returned, are no value. They are never no adoption.
- A measure with fewer peers with a value than `min_answered` is marked too few answers to compare.
- A peer that is the focus company (same identifier or same Firmable ID) is excluded and listed.
- A company listed twice counts once.
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from firmable_client import pricing
from firmable_client.errors import ConfigError, FirmableError, InputError, InvalidResponseError
from firmable_client.io import normalise_domain, read_rows
from firmable_client.recipe import PlannedCall, Recipe, RunContext
from firmable_client.report import Raw, badge, bullet_list, esc, kv, note, table

NAME = "peer-comparison"
TITLE = "AI adoption peer comparison"
DESCRIPTION = ("Compares one company's AI adoption level, areas and momentum with a peer cohort you define, "
               "using the Firmable AI Adoption API.")

DIMENSIONS = ["architecture", "footprint", "hiring", "initiatives", "workforce"]
# The order the API docs list levels in. It is used for display only and is not a ranking.
LEVEL_ORDER = ["NONE", "BASIC", "MEANINGFUL", "MODERATE", "STRONG", "ADVANCED"]
STATUSES = ["found", "not_found", "error", "not_processed", "invalid_input"]
BLANK = "(blank)"
STATUS_TONE = {"found": "good", "not_found": "unknown", "error": "error", "not_processed": "unknown",
               "invalid_input": "error", "excluded": "neutral"}
_COMPANY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TOP_KEYS = {"batch_size", "with_evidence", "min_answered"}
ENDPOINT = "POST /ai-adoption"
MEASURES = ([("overall_level", "Overall level", "level")]
            + [(d, f"{d.capitalize()} level", "level") for d in DIMENSIONS]
            + [("momentum", "Momentum", "momentum label")])
INTERPRETATION = [
    "Values are shown as Firmable's AI Adoption API returned them.",
    "The API docs define no ranking of levels. This comparison says only whether a peer has the same value as the "
    "focus company.",
    "Not found means Firmable holds no AI Adoption data for that company. It is not evidence of no adoption.",
    "The peers are the companies listed in the input. The comparison describes these peers only, not an industry, "
    "market or population.",
    "An AI adoption level or a momentum label does not prove buying intent.",
]


# ----- configuration and input ----------------------------------------------------------------

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
    min_answered = raw.get("min_answered", 5)
    if not _whole(min_answered, 1):
        raise ConfigError("min_answered must be a whole number, 1 or more.")
    return {"batch_size": batch_size, "with_evidence": with_evidence, "min_answered": min_answered}


def read_input(path: Path) -> list[dict[str, str]]:
    rows = read_rows(path, required=["role"], any_of=["domain", "company_id"])
    problems: list[str] = []
    for n, r in enumerate(rows, start=1):
        role = r["role"].strip().lower()
        if role not in ("focus", "peer"):
            problems.append(f"row {n} ({r['row_id']}): role must be focus or peer, not {r['role']!r}")
        r["role"] = role
    focus = sum(1 for r in rows if r["role"] == "focus")
    if focus != 1:
        problems.append(f"exactly one row must have role focus; found {focus}")
    if problems:
        raise InputError(f"{Path(path).name} has problems:\n  " + "\n  ".join(problems))
    return rows


# ----- subjects and batching ------------------------------------------------------------------

def subject_of(row: dict[str, str]) -> dict[str, Any]:
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
    return [PlannedCall(ENDPOINT, f"AI Adoption for the focus company and peers: {n} unique valid company(ies) in "
                        f"batches of up to {b}" + (", with evidence" if config["with_evidence"] else ""),
                        math.ceil(n / b), pricing.estimate_ai_adoption(n, config["with_evidence"]))]


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
    err = r.get("error") if isinstance(r.get("error"), dict) else None
    if isinstance(r.get("company"), dict):
        return {"state": "found", "response": r}
    if err is None or err.get("code") == "not_found":
        return {"state": "not_found", "response": r, "message": (err or {}).get("message")}
    entry = _answer_error(s["row_id"], "answer_error", err.get("code"),
                          str(err.get("message") or err.get("code") or "error"))
    ctx.errors.append(entry)
    return {"state": "error", "error": entry}


def fetch_all(ctx: RunContext, subjects: list[dict[str, Any]], batch_size: int,
              with_evidence: bool) -> dict[str, dict[str, Any]]:
    """Sends the subjects in batches. A failed batch is an error for each company in it; a fatal error
    stops later batches, which are not_processed."""
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


# ----- comparison -----------------------------------------------------------------------------

def measure_value(ai: dict[str, Any] | None, measure: str, facet: str = "level") -> Any:
    if not ai:
        return None
    if measure == "overall_level":
        return ai.get("overall_level")
    if measure == "momentum":
        return ai.get("momentum_label")
    return (ai["dimensions"].get(measure) or {}).get(facet)


def compare(focus: dict[str, Any], peers: list[dict[str, Any]], min_answered: int) -> list[dict[str, Any]]:
    found = [p["ai_adoption"] for p in peers if p["status"] == "found"]
    nf = sum(1 for p in peers if p["status"] == "not_found")
    focus_ai = focus.get("ai_adoption") if focus["status"] == "found" else None
    out = []
    for measure, label, noun in MEASURES:
        values = [measure_value(a, measure) for a in found]
        answered = [v for v in values if isinstance(v, str) and v]
        counts: dict[str, int] = {}
        for v in answered:
            counts[v] = counts.get(v, 0) + 1
        order = [] if measure == "momentum" else LEVEL_ORDER
        keys = [k for k in order if k in counts] + sorted(k for k in counts if k not in order)
        n = len(answered)
        fv = measure_value(focus_ai, measure)
        too_few = n < min_answered
        same = None
        if not (isinstance(fv, str) and fv):
            fv = None
            placement = "The focus company has no value for this measure, so it is not placed."
        elif too_few:
            placement = f"Too few answers to compare: {n} peer(s) with a value, fewer than {min_answered}."
        else:
            same = counts.get(fv, 0)
            placement = f"Same {noun} as {same} of {n} peers with data."
        out.append({"measure": measure, "label": label, "focus_value": fv,
                    "focus_observability": None if measure in ("overall_level", "momentum")
                    else measure_value(focus_ai, measure, "observability"),
                    "peers_with_value": n, "peers_no_value": nf + len(values) - n, "too_few_answers": too_few,
                    "distribution": [{"value": k, "count": counts[k]} for k in keys],
                    "same_as_focus": same, "placement": placement})
    return out


# ----- run ------------------------------------------------------------------------------------

def build_rows(ctx: RunContext, outcomes: dict[str, dict[str, Any]], with_evidence: bool) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    first_by_key: dict[str, str] = {}
    focus_row = next(r for r in ctx.rows if r["role"] == "focus")
    focus_key = subject_of(focus_row)["key"]
    focus_out = outcomes.get(focus_key) if focus_key else None
    focus_fid = None
    if focus_out and focus_out["state"] == "found":
        focus_fid = focus_out["response"]["company"].get("firmable_id")
    for r in ctx.rows:
        s = subject_of(r)
        base: dict[str, Any] = {"row_id": r["row_id"], "role": r["role"], "input": r, "subject": s["value"],
                                "subject_key": s["key"], "duplicate_of": None, "ai_adoption": None,
                                "evidence_summary": None, "api_message": None, "error": None}
        if s["key"] is None:
            rows.append({**base, "status": "invalid_input", "status_reason": s["reason"]})
            continue
        if s["key"] in first_by_key:
            base["duplicate_of"] = first_by_key[s["key"]]
        else:
            first_by_key[s["key"]] = r["row_id"]
        o = outcomes.get(s["key"]) or {"state": "not_processed", "reason": "This company was not sent."}
        if o["state"] == "found":
            base["ai_adoption"] = ai_summary(o["response"]["company"])
            if with_evidence:
                base["evidence_summary"] = evidence_summary(o["response"].get("evidence"))
        if r["role"] == "peer" and (s["key"] == focus_key or (
                focus_fid and (base["ai_adoption"] or {}).get("firmable_id") == focus_fid)):
            rows.append({**base, "status": "excluded",
                         "status_reason": f"Same company as the focus company (row {focus_row['row_id']}). Excluded "
                                          "from the peers."})
            continue
        if o["state"] == "found":
            level = base["ai_adoption"].get("overall_level")
            reason = (f"Found. Overall level {level} as returned." if isinstance(level, str) and level
                      else "Found. No overall level was returned.")
            rows.append({**base, "status": "found", "status_reason": reason})
        elif o["state"] == "not_found":
            base["api_message"] = o.get("message")
            rows.append({**base, "status": "not_found",
                         "status_reason": "Firmable has no AI Adoption data for this company (not found). This is "
                                          "not evidence of no adoption."})
        elif o["state"] == "error":
            rows.append({**base, "status": "error", "error": o["error"],
                         "status_reason": f"No answer because of an error: {str(o['error']['message']).rstrip('.')}."})
        else:
            rows.append({**base, "status": "not_processed", "status_reason": o["reason"]})
    return rows


def _unit_id(row: dict[str, Any]) -> str:
    ai = row.get("ai_adoption") or {}
    if row["status"] == "found" and isinstance(ai.get("firmable_id"), str) and ai["firmable_id"]:
        return f"firmable:{ai['firmable_id']}"
    return row.get("subject_key") or f"invalid:{row['row_id']}"


def run(ctx: RunContext) -> dict[str, Any]:
    cfg = ctx.config
    outcomes = fetch_all(ctx, unique_subjects(ctx.rows), cfg["batch_size"], cfg["with_evidence"])
    rows = build_rows(ctx, outcomes, cfg["with_evidence"])
    focus = next(r for r in rows if r["role"] == "focus")
    peer_rows = [r for r in rows if r["role"] == "peer"]
    units: dict[str, dict[str, Any]] = {}
    for r in peer_rows:
        if r["status"] != "excluded":
            units.setdefault(_unit_id(r), r)
    peers = list(units.values())
    c = {s: 0 for s in STATUSES}
    for p in peers:
        c[p["status"]] += 1
    segments: list[dict[str, Any]] = []
    if any("segment" in r["input"] for r in peer_rows):
        seg_counts: dict[str, int] = {}
        for r in peer_rows:
            label = r["input"].get("segment") or BLANK
            seg_counts[label] = seg_counts.get(label, 0) + 1
        labels = sorted(k for k in seg_counts if k != BLANK) + ([BLANK] if BLANK in seg_counts else [])
        segments = [{"segment": k, "rows": seg_counts[k]} for k in labels]
    excluded = [r for r in peer_rows if r["status"] == "excluded"]
    cohort = {"peer_rows": len(peer_rows), "companies": len(peers), "asked": c["found"] + c["not_found"] + c["error"],
              **c, "excluded_as_focus": len(excluded), "segments": segments}
    comparisons = compare(focus, peers, cfg["min_answered"])
    peers_not_found = [{"row_id": p["row_id"], "subject": p["subject"]} for p in peers if p["status"] == "not_found"]
    peers_without_answer = [{"row_id": p["row_id"], "subject": p["subject"] or p["input"].get("domain")
                             or p["input"].get("company_id") or None, "status": p["status"],
                             "reason": p["status_reason"]}
                            for p in peers if p["status"] in ("error", "not_processed", "invalid_input")]

    coverage = [
        "The peers are the companies you listed. The REST API has no general company search, so the comparison "
        "describes these peers only. It does not represent an industry, market or population.",
        "Levels are shown as returned. The API docs define no ranking of levels, so this recipe reports only whether "
        "a peer has the same value as the focus company, not whether it is higher or lower.",
        "Each placement states its denominator: the peers with a value returned for that measure.",
        "Peers not found, and areas with no level returned, are counted as no value. They are never counted as no "
        "adoption.",
        f"A measure with fewer than {cfg['min_answered']} peers with a value is marked too few answers to compare.",
        "An AI adoption level or a momentum label does not prove buying intent.",
    ]
    if focus["status"] != "found":
        coverage.append(f"The focus company has no AI Adoption answer (status {focus['status']}), so no measure "
                        "places it. The peer distribution is still shown.")
    dupes = sum(1 for r in rows if r.get("duplicate_of") and r["status"] != "excluded")
    if dupes:
        coverage.append(f"{dupes} row(s) repeat an earlier company; its answer was reused and it is counted once.")
    same = sum(1 for r in peer_rows if r["status"] != "excluded" and not r.get("duplicate_of")) - len(peers)
    if same > 0:
        coverage.append(f"{same} peer row(s) resolve to the same Firmable company as an earlier peer. They are "
                        "counted once.")
    if excluded:
        coverage.append(f"{len(excluded)} peer row(s) are the focus company and are excluded from the peers.")
    if peers_not_found:
        coverage.append(f"{len(peers_not_found)} peer(s) have no AI Adoption data in Firmable (not found). This means "
                        "no data was retrieved, not that the company has no AI adoption.")
    found_ai = [p["ai_adoption"] for p in peers if p["status"] == "found"]
    if focus["status"] == "found":
        found_ai = [focus["ai_adoption"]] + found_ai
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
    if cfg["with_evidence"]:
        coverage.append("Evidence items with qualifies false are counted separately; they do not count towards a "
                        "level. The comparison uses levels only, not evidence.")
        truncated = sum(1 for r in [focus] + peers for e in (r.get("evidence_summary") or {}).values()
                        if e.get("truncated"))
        if truncated:
            coverage.append(f"{truncated} evidence area(s) are truncated: the response holds fewer items than "
                            "item_count.")

    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    focus_level = focus["ai_adoption"].get("overall_level") if focus["status"] == "found" else None
    for r in rows:
        lvl = (r.get("ai_adoption") or {}).get("overall_level")
        r["same_overall_level_as_focus"] = None
        if (r["role"] == "peer" and r["status"] == "found" and isinstance(focus_level, str) and focus_level
                and isinstance(lvl, str) and lvl):
            r["same_overall_level_as_focus"] = "yes" if lvl == focus_level else "no"
    summary = {"status_counts": counts, "min_answered": cfg["min_answered"],
               "focus": {"row_id": focus["row_id"], "status": focus["status"],
                         "status_reason": focus["status_reason"], "subject": focus["subject"],
                         "ai_adoption": focus["ai_adoption"], "evidence_summary": focus["evidence_summary"]},
               "peer_cohort": cohort, "comparisons": comparisons, "peers_not_found": peers_not_found,
               "peers_without_answer": peers_without_answer,
               "excluded_peers": [{"row_id": r["row_id"], "subject": r["subject"]} for r in excluded]}
    return {"rows": rows, "summary": summary, "coverage": coverage}


# ----- output ---------------------------------------------------------------------------------

CSV_COLUMNS = (["row_id", "role", "domain", "company_id", "segment", "duplicate_of", "status", "status_reason",
                "firmable_id", "company_name", "overall_level", "same_overall_level_as_focus", "momentum"]
               + [f"{d}_level" for d in DIMENSIONS] + ["as_of", "framework_version"])


def csv_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in result["rows"]:
        ai = r.get("ai_adoption") or {}
        dims = ai.get("dimensions") or {}
        inp = r.get("input") or {}
        row = {"row_id": r["row_id"], "role": inp.get("role"), "domain": inp.get("domain"),
               "company_id": inp.get("company_id"), "segment": inp.get("segment"),
               "duplicate_of": r.get("duplicate_of"), "status": r["status"],
               "status_reason": r.get("status_reason") or r.get("reason"), "firmable_id": ai.get("firmable_id"),
               "company_name": ai.get("company_name"), "overall_level": ai.get("overall_level"),
               "same_overall_level_as_focus": r.get("same_overall_level_as_focus"),
               "momentum": ai.get("momentum_label"), "as_of": ai.get("as_of"),
               "framework_version": ai.get("framework_version")}
        for d in DIMENSIONS:
            row[f"{d}_level"] = (dims.get(d) or {}).get("level")
        out.append(row)
    return out


def md(value: Any) -> str:
    """Escapes Markdown special characters in API or input text. Empty values read "not returned"."""
    if value is None or value == "":
        return "not returned"
    s = str(value).replace("\r", " ").replace("\n", " ")
    s = re.sub(r"([\\`*_\[\]<>|])", r"\\\1", s)
    return "\\" + s if s.startswith("#") else s


def _dist_md(c: dict[str, Any]) -> str:
    if not c["distribution"]:
        return "none"
    return "; ".join(f"{md(d['value'])} {d['count']} of {c['peers_with_value']}" for d in c["distribution"])


def markdown(result: dict[str, Any]) -> dict[str, str]:
    s = result["summary"]
    if not s.get("focus"):
        return {}
    f = s["focus"]
    ai = f.get("ai_adoption") or {}
    pc = s["peer_cohort"]
    name = ai.get("company_name") or f.get("subject") or f["row_id"]
    lines = ["# AI adoption peer comparison", "",
             f"Focus company: {md(name)} (row {md(f['row_id'])}).", "",
             "Source: Firmable AI Adoption API. Values are shown as returned.", "",
             "## Peer cohort", "",
             f"- Peer rows in the input: {pc['peer_rows']}",
             f"- Unique peer companies compared: {pc['companies']}",
             f"- Asked: {pc['asked']}. Found: {pc['found']}. Not found: {pc['not_found']}. Error: {pc['error']}. "
             f"Not sent: {pc['not_processed'] + pc['invalid_input']}. Excluded as the focus company: "
             f"{pc['excluded_as_focus']}."]
    if pc["segments"]:
        lines.append("- Segments in the input: " + ", ".join(f"{md(x['segment'])} ({x['rows']})"
                                                               for x in pc["segments"]))
    lines += ["- The peers are the companies listed in the input. They do not represent an industry, market or "
              "population.", "", "## Focus company", "", "| Field | Value |", "| --- | --- |",
              f"| Status | {md(f['status'])} |", f"| Overall level | {md(ai.get('overall_level'))} |",
              f"| Explanation | {md(ai.get('explanation'))} |", f"| Momentum | {md(ai.get('momentum_label'))} |"]
    signals = "; ".join(f"{md(x.get('kind'))}: {md(x.get('count'))}, latest {md(x.get('latest'))}"
                        for x in ai.get("momentum_signals") or [])
    lines += [f"| Momentum signals | {signals or 'none returned'} |", f"| Data as of | {md(ai.get('as_of'))} |",
              f"| Framework version | {md(ai.get('framework_version'))} |", "",
              "## Comparison", "",
              "| Measure | Focus | Focus observability | Peers with a value | Peer counts | Peers with no value | "
              "Placement |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for c in s["comparisons"]:
        obs = "-" if c["measure"] in ("overall_level", "momentum") else md(c["focus_observability"])
        lines.append(f"| {md(c['label'])} | {md(c['focus_value'])} | {obs} | {c['peers_with_value']} | "
                     f"{_dist_md(c)} | {c['peers_no_value']} | {md(c['placement'])} |")
    lines += ["", "## Peers not found", ""]
    if s["peers_not_found"]:
        lines += [f"- Row {md(p['row_id'])}: {md(p['subject'])}" for p in s["peers_not_found"]]
        lines += ["", "Not found means Firmable holds no AI Adoption data for the company. It is not evidence of no "
                      "adoption."]
    else:
        lines.append("None.")
    lines += ["", "## Peers without an answer", ""]
    if s["peers_without_answer"]:
        lines += [f"- Row {md(p['row_id'])}: {md(p['subject'])}. {md(p['status'])}: {md(p['reason'])}"
                  for p in s["peers_without_answer"]]
    else:
        lines.append("None.")
    if s["excluded_peers"]:
        lines += ["", "## Peers excluded as the focus company", ""]
        lines += [f"- Row {md(p['row_id'])}: {md(p['subject'])}" for p in s["excluded_peers"]]
    lines += ["", "## Interpretation", ""] + [f"- {t}" for t in INTERPRETATION] + [""]
    return {"peer-comparison.md": "\n".join(lines)}


def render(report: Any, result: dict[str, Any]) -> None:
    s = result["summary"]
    f = s.get("focus")
    if not f:
        return
    ai = f.get("ai_adoption") or {}
    pc = s["peer_cohort"]
    left = kv([("Row", f["row_id"]), ("Status", f["status"]), ("Firmable ID", ai.get("firmable_id")),
               ("Overall level", ai.get("overall_level")), ("Explanation", ai.get("explanation")),
               ("Momentum", ai.get("momentum_label")), ("Data as of", ai.get("as_of")),
               ("Framework version", ai.get("framework_version"))])
    if f["status"] != "found":
        left += note(esc(f["status_reason"]), "unknown")
    right = ""
    if ai:
        right = table(["Area", "Level", "Observability", "Counts toward overall", "Headline"],
                      [[d, (ai["dimensions"].get(d) or {}).get("level"),
                        (ai["dimensions"].get(d) or {}).get("observability"),
                        (ai["dimensions"].get(d) or {}).get("counts_toward_overall"),
                        (ai["dimensions"].get(d) or {}).get("headline")] for d in DIMENSIONS])
        if ai.get("momentum_signals"):
            right += table(["Momentum signal", "Count", "Latest"],
                           [[x.get("kind"), x.get("count"), x.get("latest")] for x in ai["momentum_signals"]])
    report.add("Focus", f"Focus company: {ai.get('company_name') or f.get('subject') or f['row_id']}",
               f'<div class="cols"><div>{left}</div><div>{right}</div></div>')

    rows = []
    for c in s["comparisons"]:
        dist = "; ".join(f"{d['value']} {d['count']} of {c['peers_with_value']}" for d in c["distribution"]) or "none"
        rows.append([c["label"], c["focus_value"], c["focus_observability"], c["peers_with_value"], dist,
                     c["peers_no_value"], Raw(esc(c["placement"]) + (" " + badge("too few", "review")
                                                                     if c["too_few_answers"] else ""))])
    report.add("Comparison", "Focus company beside the peers",
               table(["Measure", "Focus", "Focus observability", "Peers with a value", "Peer counts",
                      "Peers with no value", "Placement"], rows)
               + note("Levels are not ranked: the docs define no order. A placement says only how many peers have "
                      "the same value. These peers are the companies you listed and do not represent an industry.",
                      "unknown"))

    segs = ", ".join(f"{x['segment']} ({x['rows']})" for x in pc["segments"]) or None
    report.add("Peers", "Peer cohort",
               kv([("Peer rows", pc["peer_rows"]), ("Unique peer companies", pc["companies"]),
                   ("Asked", pc["asked"]), ("Found", pc["found"]), ("Not found", pc["not_found"]),
                   ("Error", pc["error"]), ("Not sent", pc["not_processed"] + pc["invalid_input"]),
                   ("Excluded as the focus company", pc["excluded_as_focus"]), ("Segments", segs)])
               + table(["Row", "Role", "Company", "Status", "Overall level", "Same as focus", "Reason"],
                       [[r["row_id"], r["role"], (r.get("ai_adoption") or {}).get("company_name") or r.get("subject")
                         or r["input"].get("domain") or r["input"].get("company_id"),
                         Raw(badge(r["status"].replace("_", " "), STATUS_TONE.get(r["status"], "neutral"))),
                         (r.get("ai_adoption") or {}).get("overall_level"), r.get("same_overall_level_as_focus"),
                         r.get("status_reason") or r.get("reason")] for r in result["rows"]]))
    report.add("Interpretation", "How to read this comparison", bullet_list(INTERPRETATION))


RECIPE = Recipe(NAME, TITLE, DESCRIPTION, load_config, read_input, plan, run, CSV_COLUMNS, csv_rows, render,
                markdown=markdown)
