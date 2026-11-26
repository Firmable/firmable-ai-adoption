# AI adoption landscape

Shows how far a cohort of companies you supply has adopted AI, by group, by area and by momentum, with the denominator behind every count.

## Business problem

Strategy, market research, partnership and product teams often ask how far a set of companies has gone with AI. Reading one company profile at a time does not show the pattern across a list. Counting missing data as "no AI" understates adoption, and quoting a share without its denominator overstates certainty.

This recipe sends your list to the Firmable AI Adoption API in batches. It counts the levels returned for the whole cohort and for each group. Every share shows the number of companies it is taken over, and companies without data are counted separately.

The REST API has no general company search. The cohort is always the list you supply, and the results describe that list only.

## Inputs

**Input file** (CSV or JSON). One row per company.

| Column | Required | Meaning |
| - | - | - |
| `domain` | One of `domain` or `company_id` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_id` | One of `domain` or `company_id` | A Firmable company ID, such as `f000000339121`. Used instead of `domain` when both are given. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| `company_name`, `segment` or any other column | No | Kept with the row in `results.json`. Any column can be used for grouping. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `batch_size` | `100` | Companies per request, 1 to 100. |
| `with_evidence` | `false` | Asks for the evidence behind each area. Costs 3 credits per company found instead of 0.2. |
| `group_by` | `null` | `industry_group`, `size_band` or `country` from the AI Adoption answer, or the name of an input column such as `segment`. |
| `min_answered` | `5` | The fewest companies with a value a measure needs before shares are shown. |

Unknown keys are rejected.

## API calls

| Call | When | Cost |
| - | - | - |
| `POST /ai-adoption` with `records` | Once per batch of up to `batch_size` unique valid companies | 0.2 credits per company found; 3 credits per company found with evidence; not found is free |

Rows that repeat a company reuse the earlier answer and are not sent again.

## Workflow

1. Read and validate the input and configuration.
2. Work out each row's company: `company_id` when given, otherwise the normalised `domain`. A row with neither in a valid form is `invalid_input` and is not sent.
3. Send the unique companies in batches. Each record carries the row's `row_id` as `external_id`.
4. Check that each batch returns one answer per company sent, in order, with the `external_id` that was sent.
5. Build the measures for the cohort and for each group.
6. Write `report.html` (with the explorer), `results.csv` and `results.json`.

## Measurement rules

Each row gets one status:

| Status | Meaning |
| - | - |
| `found` | The API returned AI Adoption data for the company. |
| `not_found` | The API answered `company: null` with `error.code` `not_found`. Firmable holds no data; this is not evidence of no adoption. |
| `error` | The batch failed, or the row's answer carried an error other than `not_found`, or the answer did not match the company sent. |
| `not_processed` | The run stopped before this company's batch was sent. |
| `invalid_input` | The row has no valid domain or company ID. |

The measures follow these rules:

- A company is counted once in the cohort and once in each group it belongs to.
- Rows with the same identifier are one company. Rows with different identifiers that return the same `firmable_id` are also one company, and the later row shows `same_company_as`.
- For each group the block reports companies, asked, found, not found, error, not processed and invalid input.
- The overall level, each area's level, each area's observability and the momentum label each get a distribution.
- A share is a count over the companies with a value returned for that measure. The denominator (`answered`) is kept beside it.
- `no_value` counts companies not found plus companies with no value returned for that measure. Its share is taken over found plus not found.
- Shares are percentages to one decimal place, rounded half up.
- A measure with fewer than `min_answered` answered companies is marked `too_few_answers`, and its shares are left empty.
- Levels are shown as returned. The docs list levels such as `NONE`, `BASIC`, `MEANINGFUL`, `MODERATE`, `STRONG` and `ADVANCED`, but define no ranking. This recipe shows them in that listed order for reading only, and never ranks or scores them.
- A level the docs do not list is kept as its own value and named in `coverage`.
- With `group_by` set to a response field, companies without an answer are in the group `(not returned)`.
- With `group_by` set to an input column, an empty value is the group `(blank)`.

## Output

- `report.html`: the cohort at a glance, an explorer, the overall level by group, areas and momentum across the cohort, and one row per company. The raw requests and responses are at the end.
- The explorer has a group selector, a measure selector (overall level, each area's level or observability, momentum), the distribution for the selected group, the same measure across all groups, and a company list. Choosing a company shows its explanation, area headlines, momentum signals with dates, `as_of` and `framework_version`, as returned. The explorer works offline and at phone width.
- `results.csv`: one row per input row, in input order, with the status, group, levels and observability for each area.
- `results.json`: everything, including the measure blocks in `summary.cohort` and `summary.groups`, each company's summary and the request ledger.

## Estimated cost

For 500 unique companies without evidence: 5 requests and up to 100 credits. With evidence: up to 1,500 credits. Companies not found are free. Run in plan mode to see the upper bound for your own file.

## Commands

Install first; see [Getting started](../../docs/getting-started.md).

```bash
# Python, plan mode (no API calls)
firmable-adoption-landscape --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-adoption-landscape --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 5
```

The underlying request is in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- A failed batch marks every company in it as `error`. Other batches still count.
- A batch that times out, returns a 5xx, returns a body that is not valid, or returns the wrong number of answers may still have been charged. It is counted under "Requests with an uncertain charge".
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written, and companies in later batches are marked `not_processed`.
- Nothing is retried automatically.
- The cohort is the list you supply. The REST API has no general company search, so the measures do not describe a market, sector or population.
- Not found means Firmable holds no AI Adoption data for the company. It is never counted as no adoption.
- An AI adoption level or a momentum label does not prove buying intent.
- The docs define no order for levels, observability or momentum labels, so nothing is ranked.
- When answers come from more than one `framework_version`, `coverage` says so. Levels from different versions may not be comparable.
- An area with `LOW` observability is counted in `coverage`. Firmable can see little of that area for the company.
- With evidence, items with `qualifies` false are counted separately, and truncated areas are counted in `coverage`.
- The response does not say which organisation each evidence item belongs to beyond its `ref`. Evidence that belongs to a different organisation cannot be detected by this recipe.
- Explanations, headlines and momentum signals are shown as returned.
