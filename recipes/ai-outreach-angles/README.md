# AI outreach angles

Suggests outreach angles for each account in your list. Each angle comes from a template you write, is chosen by fixed conditions on the account's AI Adoption facts, and is filled only with those facts and your input. Every angle is labelled as a suggestion and shown beside the facts it used.

## Business problem

A rep preparing outreach wants a relevant opening for each account, grounded in what Firmable observes about its AI adoption. Writing each one by hand is slow. A generated message can state things the data does not support.

This recipe keeps the wording in your hands and the facts in the API's. You write a small set of angle templates and the conditions under which each applies. The recipe checks those conditions against the returned facts, fills the matching templates, and shows exactly which facts were used. It does not write new text, and it never presents an angle as a fact.

It differs from the gtm-starter-kit recipes `ai-adoption-segmentation`, which places accounts into segments, and `ai-account-brief`, which lays out the evidence for one account. This recipe produces per-account talk angles from templates.

## Inputs

**Input file** (CSV or JSON). One row per account. The REST API has no company search, so the accounts are the ones you list.

| Column | Required | Meaning |
| - | - | - |
| `company_id` | One of `company_id` or `domain` | A Firmable company ID, such as `f000000339121`. Used when present. |
| `domain` | One of `company_id` or `domain` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_name` | No | Your own name for the account. Fills `{company_name}` only when AI Adoption returns no name. |
| `segment` | No | Kept as given and copied to `results.csv`. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| Any other column | No | Kept with the row in `results.json`. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `angles` | Required | From 1 to 20 angles, checked in order. |
| `angles[].id` | Required | A short identifier: 1 to 40 lower-case letters, digits or underscores. Unique. |
| `angles[].when` | Required | The conditions, with at least one of the three below. Every condition given must hold. |
| `angles[].when.overall_level_in` | Optional | A list of overall levels, such as `["STRONG", "ADVANCED"]`. |
| `angles[].when.dimension` | Optional | `{"name": area, "level_in": [levels]}`. `name` is one of `architecture`, `footprint`, `hiring`, `initiatives`, `workforce`. |
| `angles[].when.momentum_in` | Optional | A list of momentum labels, such as `["EXPANDING"]`. |
| `angles[].template` | Required | The angle text with `{placeholder}` names. |
| `batch_size` | `100` | The most accounts sent in one AI Adoption request, from 1 to 100. |

Templates can use these placeholders:

| Placeholder | Value | Source |
| - | - | - |
| `{company_name}` | `company_name` from AI Adoption, or the input `company_name` when AI Adoption returns none | AI Adoption or input |
| `{overall_level}` | `overall_level` | AI Adoption |
| `{momentum}` | `momentum.label` | AI Adoption |
| `{dimension}` | The area named in `when.dimension.name` | Configuration |
| `{dimension_level}` | That area's `level` | AI Adoption |
| `{headline}` | That area's `headline` | AI Adoption |

`{dimension}`, `{dimension_level}` and `{headline}` need `when.dimension`. A template that names another placeholder, uses an area placeholder without `when.dimension`, or has an unmatched brace is rejected before any call. Unknown keys are rejected too.

## API calls

| Call | When | Cost |
| - | - | - |
| `POST /ai-adoption` with `records` | Once per batch of up to `batch_size` unique valid accounts | 0.2 credits per company found (1 credit per 5); free when not found |

Each record carries `company_id` or `domain` and an `external_id` set to the first input row for that account. Evidence is not requested. Duplicate accounts are sent once and the answer is reused.

## Workflow

1. Read and validate the input and configuration, including every template.
2. For each row, use `company_id` when given, otherwise the normalised domain. An invalid identifier is reported and skipped.
3. Send the unique valid accounts to `POST /ai-adoption` in batches, in input order.
4. Match each answer to its account by position, and check that any `external_id` the API echoes matches the one sent.
5. For each account with AI adoption data, check every angle's conditions, then fill the matching templates.
6. Write `report.html`, `results.csv`, `results.json` and `outreach-angles.md`.

## Angle rules

**Conditions.** Each condition compares one returned value with the configured list, ignoring case. Levels and labels are matched by name only and are never ordered. Each condition has one result:

| Result | Rule |
| - | - |
| `yes` | The returned value is in the list. |
| `no` | The returned value is not in the list. |
| `unknown` | The API did not return the value. |

**Angle outcome.** Each angle gets one outcome per account:

| Outcome | Rule |
| - | - |
| Not matched | At least one condition is `no`. |
| Not evaluated | No condition is `no`, and at least one is `unknown`. The fields that were not returned are listed. |
| Skipped | Every condition is `yes`, and a placeholder has no value. The missing placeholders are listed. |
| Filled | Every condition is `yes`, and every placeholder has a value. The angle is marked `suggested_angle` and records each condition and each placeholder's value and source. |

Each account gets one status:

| Status | Rule |
| - | - |
| `angles_found` | At least one angle was filled. |
| `no_angle` | AI Adoption returned the account, and no angle was filled. |
| `not_found` | AI Adoption returned `company: null` with `error.code` `not_found`, or no error code. No angle is produced, and this is not a finding of no AI adoption. |
| `invalid_input` | The `company_id` or `domain` is not valid. No call is made. |
| `error` | The batch request failed, the batch answer was malformed, the answer row carried a different `external_id`, or the answer row had an error other than `not_found`. |
| `not_processed` | The run stopped before this row. |

## Output

- `outreach-angles.md`: one section per input row. An account with data shows its overall level, momentum label and data date as returned, then each filled angle as a block quote headed "Suggested, not a fact", with a table of the conditions and placeholders it used and their sources. Skipped and not-evaluated angles are listed after. Other rows say why no angle was produced. API text is escaped so it cannot change the Markdown layout.
- `report.html`: a summary of how many accounts each angle was filled for, out of the accounts with AI adoption data, then one card per row. Facts are on the left. Angles are on the right, each in a separate dashed box.
- `results.csv`: one row per input row, in input order, with the status, levels, filled angle ids and text, and skipped and not-evaluated angle ids.
- `results.json`: everything, including every condition result, each placeholder's source, and the request ledger with every response as returned.

## Estimated cost

For 100 unique accounts: up to 20 credits in one request. Accounts not found cost nothing. Part-credits carry over between requests. Run in plan mode to see the upper bound for your own file.

## Commands

Run from the recipe folder after installing (see the Python and TypeScript READMEs).

```bash
# Python, plan mode (no API calls)
firmable-ai-outreach-angles --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-ai-outreach-angles --input examples/input.csv --config config.example.json --out out --live --max-credits 3
```

```bash
# TypeScript, plan mode (no API calls)
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out

# TypeScript, live
node typescript/dist/src/cli.js --input examples/input.csv --config config.example.json --out out --live --max-credits 3
```

The underlying request is in [curl/requests.sh](curl/requests.sh).

## Errors, limitations and unknowns

- A request that times out or gets a 5xx response may still have been charged. It is counted under "Requests with an uncertain charge".
- A failed batch fails every account in it with the same error, recorded once.
- A bad key, no credits, a blocked redirect or reaching `--max-credits` stops the run. Results so far are written, and later rows are marked `not_processed`.
- Nothing is retried automatically.
- Angles are suggestions from your templates. They are not facts, and the recipe does not check that the template wording is accurate.
- An AI adoption level or momentum label does not prove buying intent.
- New levels and labels can appear. They are matched by name like any other, so a condition only matches a value you listed.
- Headlines are the API's own text and can be long. They are inserted as returned.
- The same company given once by `company_id` and once by `domain` is sent twice, because the recipe cannot know they match before the answer comes back.
