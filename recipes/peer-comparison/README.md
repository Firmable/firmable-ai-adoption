# AI adoption peer comparison

Compares one company's AI adoption with a peer cohort you define, and says how many peers share each of its values.

## Business problem

A strategy, partnership or product team wants to know where one company stands on AI against a set of peers it has chosen. A single profile gives no context. A loose comparison such as "ahead of its peers" hides how many peers had data, and treats missing data as no adoption.

This recipe asks the Firmable AI Adoption API about the focus company and every peer in one batched call. It puts the focus company's overall level, area levels and momentum beside the peers' counts. Each placement states how many peers had a value.

The REST API has no general company search. The peers are the companies you list, and the comparison describes those peers only.

## Inputs

**Input file** (CSV or JSON). One row per company.

| Column | Required | Meaning |
| - | - | - |
| `role` | Yes | `focus` for exactly one row, `peer` for every other row. Case is ignored. |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works. |
| `company_id` | One of `domain` or `company_id` | A Firmable company ID. Used instead of `domain` when both are given. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| `segment` | No | Your own label for the peer. The report counts peer rows per segment to describe the cohort. |
| Any other column | No | Kept with the row in `results.json`. |

An input with no focus row, more than one, or another role value is rejected before any call.

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `min_answered` | `5` | The fewest peers with a value a measure needs before the focus company is placed. |
| `with_evidence` | `false` | Asks for the evidence behind each area. Costs 3 credits per company found instead of 0.2. The comparison uses levels only. |
| `batch_size` | `100` | Companies per request, 1 to 100. |

Unknown keys are rejected.

## API calls

| Call | When | Cost |
| - | - | - |
| `POST /ai-adoption` with `records` | Once per batch of up to `batch_size` unique valid companies, focus included | 0.2 credits per company found; 3 credits per company found with evidence; not found is free |

## Workflow

1. Read and validate the input and configuration.
2. Work out each row's company: `company_id` when given, otherwise the normalised `domain`.
3. Send the unique companies in batches, each with its `row_id` as `external_id`.
4. Exclude any peer that is the focus company, by identifier or by `firmable_id`.
5. Count each unique peer once and compare it with the focus company on each measure.
6. Write `report.html`, `peer-comparison.md`, `results.csv` and `results.json`.

## Comparison rules

The measures are the overall level, the level of each area (`architecture`, `footprint`, `hiring`, `initiatives`, `workforce`) and the momentum label.

For each measure:

- The peer distribution counts peers with a value returned. That count is the denominator.
- Peers not found, and peers with no value for the measure, are counted as "peers with no value". They are never counted as no adoption.
- When the focus company has a value and at least `min_answered` peers have a value, the placement reads "Same level as n of m peers with data".
- When fewer than `min_answered` peers have a value, the placement reads "Too few answers to compare".
- When the focus company has no value, the placement says it is not placed. The peer distribution is still shown.
- The docs define no ranking of levels. The recipe reports only whether a peer has the same value, never higher or lower.
- A level the docs do not list is kept as its own value.

Each peer row gets one status: `found`, `not_found`, `error`, `not_processed`, `invalid_input` or `excluded` (the peer is the focus company). The focus row gets one of the first five.

## Output

- `peer-comparison.md`: the peer cohort description (rows, unique companies, segments), the focus company's values as returned, the comparison table, peers not found, peers without an answer, excluded peers and a fixed interpretation section. API text is escaped for Markdown.
- `report.html`: the focus company with its areas and momentum signals, the comparison table, the peer cohort and every row. The raw requests and responses are at the end.
- `results.csv`: one row per input row with the status, levels and `same_overall_level_as_focus` (`yes`, `no` or empty).
- `results.json`: everything, including `summary.comparisons`, `summary.peer_cohort` and the request ledger.

## Estimated cost

For a focus company and 20 peers without evidence: one request and up to 4.2 credits. With evidence: up to 63 credits. Companies not found are free. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see [Getting started](../../docs/getting-started.md).

```bash
# Python, plan mode (no API calls)
firmable-peer-comparison --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-peer-comparison --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

The underlying request is in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- A failed batch marks every company in it as `error`. When the focus company has no answer, no measure places it.
- A batch that times out, returns a 5xx or returns an answer that is not valid may still have been charged. It is counted under "Requests with an uncertain charge".
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written, and companies in later batches are marked `not_processed`.
- Nothing is retried automatically.
- The peers are the companies you list. They do not represent an industry, market or population, and the report says so.
- Not found means Firmable holds no AI Adoption data. It is never counted as no adoption.
- An AI adoption level or a momentum label does not prove buying intent.
- Levels are not ranked, because the docs define no order.
- When answers come from more than one `framework_version`, `coverage` says so.
- With evidence, truncated areas are counted in `coverage`. Evidence is not used in the comparison.
- Explanations, headlines and momentum signals are shown as returned.
