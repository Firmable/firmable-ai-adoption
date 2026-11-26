# AI momentum watchlist

Flags the accounts in your list whose AI Adoption momentum label is one you chose and whose momentum signals are recent. Every label, signal and date is shown as returned, beside the rule that placed the account on or off the watchlist.

## Business problem

Sales and marketing teams want to know which accounts are showing AI momentum now, so they can time outreach. Checking each account by hand is slow, and a judgement made by eye is hard to repeat.

This recipe applies one fixed, documented rule to every account: a qualifying momentum label plus at least one signal dated within a window you set. It keeps accounts with no AI adoption data apart from accounts without momentum. A watch status means the rule matched. It does not prove buying intent.

## Inputs

**Input file** (CSV or JSON). One row per account. The REST API has no company search and no list of companies by momentum, so the accounts are the ones you list.

| Column | Required | Meaning |
| - | - | - |
| `company_id` | One of `company_id` or `domain` | A Firmable company ID, such as `f000000339121`. Used when present. |
| `domain` | One of `company_id` or `domain` | The company's website domain. A full URL also works; the scheme, `www.` and path are removed. |
| `company_name` | No | Your own name for the account. Shown when AI Adoption returns no name. |
| `segment` | No | Kept as given and copied to `results.csv`. |
| `row_id` | No | Your own row identifier. Defaults to `row-1`, `row-2` and so on. Must be unique. |
| Any other column | No | Kept with the row in `results.json`. |

**Configuration** (`config.example.json`).

| Key | Default | Meaning |
| - | - | - |
| `labels` | `["EXPANDING"]` | The momentum labels that qualify. Matched ignoring case. A label the docs do not list is accepted and matched as written. |
| `signal_kinds` | left out | The signal kinds that count, such as `["AI hiring"]`, matched ignoring case. Left out, every kind counts. |
| `recent_days` | `90` | How many days before `evaluation_date` a signal's `latest` date may be and still count as recent, from 1 to 3650. |
| `evaluation_date` | Required | The date recency is measured from, as `YYYY-MM-DD`. It is required so a run gives the same answer every time. |
| `batch_size` | `100` | The most accounts sent in one AI Adoption request, from 1 to 100. |

Unknown keys, an empty label list, repeated labels and an invalid date are rejected before any call.

## API calls

| Call | When | Cost |
| - | - | - |
| `POST /ai-adoption` with `records` | Once per batch of up to `batch_size` unique valid accounts | 0.2 credits per company found (1 credit per 5); free when not found |

Each record carries `company_id` or `domain` and an `external_id` set to the first input row for that account. Evidence is not requested. Duplicate accounts are sent once and the answer is reused.

## Workflow

1. Read and validate the input and configuration.
2. For each row, use `company_id` when given, otherwise the normalised domain. An invalid identifier is reported and skipped.
3. Send the unique valid accounts to `POST /ai-adoption` in batches, in input order.
4. Match each answer to its account by position, and check that any `external_id` the API echoes matches the one sent.
5. Apply the watch rule to each account with AI adoption data.
6. Write `report.html`, `results.csv` and `results.json`.

## Watch rule

For each signal in `momentum.signals`:

- The signal is **selected** when `signal_kinds` is left out, or its `kind` is in `signal_kinds`.
- Its date is the `YYYY-MM-DD` at the start of `latest`. A time after the date is ignored. A missing or invalid date makes the signal **undated**.
- A selected, dated signal is **recent** when its date is on or before `evaluation_date` and no more than `recent_days` days before it.
- A signal dated after `evaluation_date` is not recent. It is noted on the row.

Each account gets one status:

| Status | Rule |
| - | - |
| `watch` | The momentum `label` is in `labels`, and at least one selected signal is recent. |
| `label_only` | The momentum `label` is in `labels`, and no selected signal is recent. Undated, older and later signals are listed. |
| `not_watch` | The momentum `label` is not in `labels`, or no label was returned. A missing label is stated as such and is not a finding of no momentum. |
| `not_found` | AI Adoption returned `company: null` with `error.code` `not_found`, or no error code. The account is not counted as having no momentum. |
| `invalid_input` | The `company_id` or `domain` is not valid. No call is made. |
| `error` | The batch request failed, the batch answer was malformed, the answer row carried a different `external_id`, or the answer row had an error other than `not_found`. |
| `not_processed` | The run stopped before this row. |

Every row keeps the label and each signal's `kind`, `count` and `latest` as returned, with `kind_selected`, `days_before_evaluation` and `recency` added.

## Output

- `report.html`: a summary with counts and their denominators, then one table per status with each account's label, signals and the reason for its status.
- `results.csv`: one row per input row, in input order, with the status, reason, label, recent signals, latest recent signal date, all signals, overall level and data date.
- `results.json`: everything, including the per-signal recency and the request ledger with every response as returned.

The summary counts `watch`, `label_only` and `not_watch` out of the unique accounts with AI adoption data, and states that number beside each count. Counts describe the accounts in your file only.

## Estimated cost

For 100 unique accounts: up to 20 credits in one request. Accounts not found cost nothing. Part-credits carry over between requests, so the charge is taken in whole credits as your organisation reaches each 5 companies. Run in plan mode to see the upper bound for your own file.

## Commands

Run from the recipe folder after installing (see the Python and TypeScript READMEs).

```bash
# Python, plan mode (no API calls)
firmable-ai-momentum-watchlist --input examples/input.csv --config config.example.json --out out

# Python, live
export FIRMABLE_API_KEY=fbl_dev_...
firmable-ai-momentum-watchlist --input examples/input.csv --config config.example.json --out out --live --max-credits 3
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
- The API documents one momentum label, `EXPANDING`. Other labels may appear and are shown as returned.
- Each signal has only a `latest` date and a `count`. The recipe cannot tell when earlier occurrences happened, so recency rests on the latest date only.
- This code computes no score and no trend. AI momentum does not prove buying intent.
- The same company given once by `company_id` and once by `domain` is sent twice, because the recipe cannot know they match before the answer comes back.
