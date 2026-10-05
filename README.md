# @xalantis/mcp-server

MCP server for Xalantis. It lets MCP-compatible AI clients read and act on Xalantis business data through the public `/api/v1` API.

Release `0.3.0` reaches all 323 operations of the public API (contract 2.11.0): dedicated tools for the most frequent tasks, and four generic tools driven by the bundled OpenAPI spec for everything else.

## Installation

```bash
npm install -g @xalantis/mcp-server
```

## Configuration

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xalantis": {
      "command": "npx",
      "args": ["-y", "@xalantis/mcp-server"],
      "env": {
        "XALANTIS_API_KEY": "sk_live_..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add xalantis -- npx -y @xalantis/mcp-server
```

Then set `XALANTIS_API_KEY` in the shell/session that launches the MCP server.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "xalantis": {
      "command": "npx",
      "args": ["-y", "@xalantis/mcp-server"],
      "env": {
        "XALANTIS_API_KEY": "sk_live_..."
      }
    }
  }
}
```

## Covered domains

Dedicated tools:

- Support / Service Desk: tickets, replies, attachments, reports, links, watchers, time entries, subtasks, incidents, service requests, SLA, automations, categories, tags, service catalog, agents.
- CRM: clients, representatives, contacts, deals, pipelines.
- Knowledge: articles, search, categories, managed article drafts and reviews.
- Billing: subscription and invoices.
- Finance: invoices and expenses read-only APIs.
- Contracts: contracts, comments, negotiations, obligations, approvals, signatures, clauses, requests, PDF designs, assets, assignments.
- Projects: projects, statuses, tasks (list, read, create, update, transition) and task comments.

Through the generic tools: every other operation of the public API, including the rest of Projects (sprints, milestones, lists, labels, custom fields, documents, time tracking, automations, analytics, exports, imports, client portal), compliance cases, signature envelopes, contract referentials and CRM imports.

## Generic API access

Four tools cover any operation of the public API without a dedicated tool:

1. `search_operations`: finds operations by keywords (all required, accents ignored; summaries are in French), area and HTTP method. Without arguments, lists the areas.
2. `describe_operation`: returns the path, query and header parameters, the body schema and the scopes of one operation.
3. `read_operation`: runs a `GET` operation. Binary or CSV responses can be written to a local file with `save_to`.
4. `call_operation`: runs a `POST`, `PUT`, `PATCH` or `DELETE` operation. Requires `confirm: true`; multipart uploads take local paths in `files`.

```json
{
  "operation_id": "post_projects_By_projectUuid_tasks_By_taskUuid_time_entries",
  "path_params": { "projectUuid": "project-uuid", "taskUuid": "task-uuid" },
  "body": { "duration_minutes": 45, "description": "Review" },
  "confirm": true
}
```

The spec ships with the package (`openapi/xalantis-openapi.json`) and is refreshed at each release. Text responses above 200 KB are refused with a hint to paginate or use `save_to`.

Every write sends an `Idempotency-Key`, generated for each call unless one is passed in `headers`: about 80 routes require it, and replaying the same key returns the first response without a second effect.

Project routes require an API key linked to a member of the workspace (keys created from the Developers settings are) and the matching `projects:*` scopes.

## Confirmation model

Tools that mutate data or may expose sensitive data require a `confirm: true` argument. The AI client should only pass this after the user explicitly confirms the action.

Examples of confirmed actions:

- creating, updating or deleting records;
- sending public ticket replies;
- approving, rejecting, fulfilling or reopening service requests;
- merging, splitting, archiving or deleting tickets;
- requesting contract signatures;
- downloading attachments or reports;
- uploading files.

If confirmation is missing, the tool returns an error explaining that confirmation is required.

## File transfer tools

Binary endpoints are supported through file-aware tools:

```json
{
  "ticket_uuid": "ticket-uuid",
  "file_path": "/local/path/evidence.pdf",
  "confirm": true
}
```

Downloads can either return base64 or write to a local path:

```json
{
  "ticket_uuid": "ticket-uuid",
  "attachment_uuid": "attachment-uuid",
  "output_path": "/tmp/evidence.pdf",
  "confirm": true
}
```

When `output_path` is omitted, the tool returns metadata plus base64 content.

## Example prompts

Once connected, an MCP-compatible assistant can answer or act on prompts such as:

- “List open urgent tickets and summarize the oldest ones.”
- “Find client Acme and show related contacts.”
- “Search the knowledge base for SLA configuration.”
- “Create this Knowledge draft and submit it for editorial review after I confirm.”
- “Update this published Knowledge article; keep the live version unchanged until approval.”
- “Create a ticket for this incident after I confirm.”
- “Add an internal note to this ticket.”
- “Show contract obligations due this month.”
- “Submit this contract for approval after confirmation.”
- “Download this ticket report to `/tmp/report.xlsx`.”
- “List the overdue tasks of project MXA and move the ones I pick to Done.”
- “Log 45 minutes on this task and show the sprint burndown.”

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `XALANTIS_API_KEY` | Yes | Tenant API key used for Xalantis `/api/v1` requests. |
| `XALANTIS_BASE_URL` | No | Origin or API base of your Xalantis instance, e.g. `https://app.example.com`. Defaults to `https://xalantis.com/api/v1`. |

## Security notes

- The MCP server does not bypass Xalantis backend permissions, plan gates, tenant scoping or rate limits.
- Destructive and externally visible actions require `confirm: true`.
- File downloads can contain sensitive tenant data; use `output_path` carefully.
- API keys should be stored in the MCP client environment configuration, not in prompts.

## Development

```bash
npm ci
npm run lint
npm test            # compiles, then checks every tool against the bundled spec
npm run sync-openapi -- path/to/openapi.json
```

`npm test` calls every tool with a fake transport and fails if one targets a route the spec does not declare or sends a write without an `Idempotency-Key`. Run `sync-openapi` before a release (default source: the sibling `xalantis-application/storage/app/openapi.json`).

## License

MIT
