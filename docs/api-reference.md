# API reference

The examples use 1 endpoint of the Firmable developer REST API. This page summarises what the recipes rely on. The [Firmable documentation](https://docs.firmable.com) and its [OpenAPI file](https://docs.firmable.com/api-reference/openapi.json) are the source of truth.

Base URL: `https://api.firmable.com`. Authentication: `Authorization: Bearer <key>`. Rate limit: 15 requests a second per key for each of these endpoints; over the limit the API returns `429` with a `retry-after` header.

| Endpoint | Inputs the recipes use | Notes |
| - | - | - |
| `POST /ai-adoption` | `{company_id}` or `{domain}`, or `{records: [...]}` up to 100; `?withEvidence=true` | A company with no data returns `200` with `company: null` and is free. |

## What the recipes do not use

- MCP tools. Some MCP behaviour, such as searching people by name, has no REST equivalent and is not copied.
- Partner endpoints, which need partner keys.
- `GET /filter-options`. No recipe needs it; the people-search ID lists are in the people-search documentation.
