# Changelog

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
