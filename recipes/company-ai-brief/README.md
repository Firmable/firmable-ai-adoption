# Company AI brief

Builds a Markdown brief of the AI adoption evidence Firmable holds for each company you list. Each brief shows the overall level, explanation and momentum as returned, then each of the five AI Adoption areas with its level, headline, observability, evidence count and evidence items. Qualifying and non-qualifying evidence are kept apart, and gaps are stated.

## Business problem

Strategy, market research, partnerships and product teams sometimes need to know what Firmable holds about one company's AI adoption, and on what evidence. Reading raw API responses is slow. A summary written by hand or by a model can drift from what the data says.

This recipe lays out the API's own levels, explanations and headlines without changing them. It shows each evidence item with the fields the API returned and its reference. It says where evidence is missing, truncated or questionable. It never treats "not observed" as "no adoption".

## Inputs

**Input file** (CSV or JSON). One row per company, from 1 to 25 rows. The REST API has no company search, so the companies are the ones you list.

| Column | Required | Meaning |
| - | - | - |
| `company_id` | One of `company_id` or `domain` | A Firmable company ID, such as `f000000339121`. Used when present. |
| `domain` | One of `company_id` or `domain` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_name` | No | Your own name for the company. Kept as given and compared with the name AI Adoption returns. |
| `segment` | No | Kept as given. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. It names the brief file. |
| Any other column | No | Kept with the row in `results.json`. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `with_evidence` | `true` | Requests AI Adoption evidence (`withEvidence=true`). Costs 3 credits per company found with evidence instead of 0.2. |
| `max_items_per_area` | `5` | The most evidence items each brief shows per area, from 0 to 100. Items are taken in the order the API returned them. |
| `batch_size` | `100` | The most companies sent in one AI Adoption request, from 1 to 100. |

Unknown keys are rejected before any call.

## API calls

| Call | When | Cost |
| - | - | - |
| `POST /ai-adoption?withEvidence=true` with `records` | Once per batch of up to `batch_size` unique valid companies | 3 credits per company found with evidence; 0.2 per company found without evidence; free when not found |

Each record carries `company_id` or `domain` and an `external_id` set to the first input row for that company. Duplicate companies in the input are sent once and the answer is reused.

## Workflow

1. Read and validate the input and configuration.
2. For each row, use `company_id` when given, otherwise the normalised domain. An invalid identifier is reported and skipped.
3. Send the unique valid companies to `POST /ai-adoption` in batches, in input order.
4. Match each answer to its company by position, and check that any `external_id` the API echoes matches the one sent.
5. Build the brief content for each company found, and assign one brief file per company.
6. Write `report.html`, `results.csv`, `results.json` and one `ai-brief-<row_id>.md` per company.

## Brief rules

**Overall level and momentum.** The overall level, explanation, momentum label and signals (kind, count, latest date), data date and framework version are shown as returned. A level that is not one of the documented levels (`NONE`, `BASIC`, `MEANINGFUL`, `MODERATE`, `STRONG`, `ADVANCED`) is shown as returned with a note. Levels are never ordered or scored.

**Areas.** Each of `architecture`, `footprint`, `hiring`, `initiatives` and `workforce` shows its `level`, `headline`, `observability`, `counts_toward_overall` and `evidence_available`. Area-specific detail is kept in `results.json` and the report.

**Evidence.** Each area's returned items are split by the API's `qualifies` field:

| Group | Rule |
| - | - |
| Qualifying | `qualifies` is `true`. The item counts towards the area's level. |
| Not qualifying | `qualifies` is `false`. |
| Qualification unstated | `qualifies` is missing or not true or false. |

The brief shows the first `max_items_per_area` items in the order the API returned them, then splits those into the three groups. Each group heading gives how many items of that group were returned and how many are shown. Every item is shown with its `ref` and every other field the API returned for it.

**Flags.** An area is flagged when:

- the API returned no data for the area;
- `evidence_available` is above 0 but no evidence came back for the area;
- the area's evidence is `truncated`;
- a workforce item names a different organisation in a field the API returned (see below).

**Workforce items from another organisation.** The documented workforce item fields do not name an employer. The recipe checks only fields that name an organisation when the API returns them: `company_id`, `firmable_id` and `organisation_id` are compared with the AI Adoption `firmable_id`; `company_name`, `employer`, `organisation` and `company` are compared, ignoring case, with the AI Adoption `company_name`. A flagged item is shown, not removed.

**Not observed.** An area with no evidence returned, or no level, is listed under "Not observed". The brief says this does not mean the company has no AI activity in that area.

**Conflicting facts.** The brief lists, without correcting, a company name in your input that differs from the AI Adoption `company_name`, and a `firmable_id` that differs from the `company_id` you sent.

Each row gets one status:

| Status | Rule |
| - | - |
| `brief_ready` | AI Adoption returned the company. A brief file is written. |
| `not_found` | AI Adoption returned `company: null` with `error.code` `not_found`, or no error code. A brief file is written saying Firmable holds no AI adoption data for the company, which is not a finding of no AI adoption. |
| `invalid_input` | The `company_id` or `domain` is not valid. No call is made. |
| `error` | The batch request failed, the batch answer was malformed, the answer row carried a different `external_id`, or the answer row had an error other than `not_found`. The reason says which. |
| `not_processed` | The run stopped before this row. |

A repeated company shares the first row's brief file and has `duplicate_of` set.

## Output

- `ai-brief-<row_id>.md`: one brief per company, with `row_id` characters other than letters, digits, `-` and `_` replaced by `_`. API text is escaped so it cannot change the Markdown layout.
- `report.html`: a status summary, then one card per row with the same content as the brief. The raw requests and responses are at the end.
- `results.csv`: one row per input row, in input order, with the status, levels, momentum label, evidence count, truncated areas, flags and brief file name.
- `results.json`: everything, including the shown evidence items, counts per group, area detail and the request ledger with every response as returned.

## Estimated cost

For 25 companies with evidence: up to 75 credits. Companies not found cost nothing. Without evidence, the same 25 companies cost up to 5 credits. Before reading, AI Adoption checks that your organisation could pay for every company in the batch as if each were found: 75 credits for a batch of 25 with evidence. If not, the call returns `402` and nothing is charged. Run in plan mode to see the upper bound for your own file.

## Commands

Run from the recipe folder after installing (see the Python and TypeScript READMEs).

```bash
# Python, plan mode (no API calls)
firmable-company-ai-brief --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-company-ai-brief --input examples/input.csv --config config.example.json --out out --live --max-credits 10
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 10
```

The underlying request is in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge".
- A batch answer with a different number of results than records sent is treated as an invalid response for every company in that batch, and its charge is counted as uncertain.
- A failed batch fails every company in it with the same error, recorded once.
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written, and later rows are marked `not_processed`.
- Nothing is retried automatically.
- The same company given once by `company_id` and once by `domain` is sent twice, because the recipe cannot know they match before the answer comes back.
- This code computes no score, no trend and no narrative. Levels, explanations and headlines are the API's own words.
- An AI adoption level does not prove buying intent.
- AI Adoption evidence can be truncated. The brief says how many items came back out of `item_count`.
- Workforce evidence that belongs to another organisation is detectable only when the API returns a field naming that organisation. The documented fields do not include one.
