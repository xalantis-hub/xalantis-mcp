# Changelog

## 0.3.0 — 2026-10-05

### Added

- Generic access to all 323 operations of the public API (contract 2.11.0) through `search_operations`, `describe_operation`, `read_operation` and `call_operation`, driven by the OpenAPI spec bundled in `openapi/`.
- Project tools: `list_projects`, `get_project`, `list_project_statuses`, `list_project_tasks`, `get_project_task`, `create_project_task`, `update_project_task`, `transition_project_task`, `list_project_task_comments`, `add_project_task_comment`.
- Knowledge article management tools (drafts, updates, review submission, archive, delete).
- `XALANTIS_BASE_URL` to target another Xalantis instance.
- Server instructions that tell the client when to use dedicated or generic tools; read-only and destructive hints on the new tools.
- `npm test`: every tool is checked against the routes of the bundled spec.

### Changed

- Every write sends a generated `Idempotency-Key` unless one is provided; the routes that require one no longer fail.
- Query booleans are sent as `1`/`0` and arrays as repeated `name[]` values, as Laravel validation expects.
- API errors returned in the top-level `{ message, code, errors }` shape keep their message and details.
- The server reports the package version instead of `0.1.0`.

### Removed

- `get_ticket_automation` and `get_ticket_reply_template`: the API has no such route and they always failed. Use `list_ticket_automations` and `list_ticket_reply_templates`.

## 0.2.0 — 2026-07-28

### Added

- Full current public `/api/v1` endpoint coverage for the MCP server.
- Support / Service Desk tools for tickets, replies, attachments, reports, links, watchers, time entries, subtasks, incidents, service requests, SLA, automations, categories, tags, service catalog and agents.
- CRM tools for clients, representatives, contacts, deals and pipelines.
- Knowledge tools for article listing, search, categories and lookup.
- Billing tools for subscription and invoices.
- Finance tools for invoices and expenses.
- Contract tools for contracts, comments, negotiations, obligations, approvals, signatures, clauses, requests, PDF designs, assets and assignments.
- File transfer tools:
  - `upload_ticket_attachment`
  - `download_ticket_attachment`
  - `download_ticket_report`
- Confirmation guard for sensitive or destructive mutations through `confirm: true`.

### Notes

- The server returns API data as JSON text content for MCP clients.
- Backend permissions, tenant scoping, plan gates and rate limits remain authoritative.

## 0.1.0

- Initial ticket and ticket reply MCP server.
