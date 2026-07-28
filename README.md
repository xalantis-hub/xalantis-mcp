# @xalantis/mcp-server

MCP server for Xalantis. It lets MCP-compatible AI clients read and act on Xalantis business data through the public `/api/v1` API.

Release `0.2.0` covers every current public `/api/v1` endpoint exposed by Xalantis at the time of release.

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

- Support / Service Desk: tickets, replies, attachments, reports, links, watchers, time entries, subtasks, incidents, service requests, SLA, automations, categories, tags, service catalog, agents.
- CRM: clients, representatives, contacts, deals, pipelines.
- Knowledge: articles, search, categories.
- Billing: subscription and invoices.
- Finance: invoices and expenses read-only APIs.
- Contracts: contracts, comments, negotiations, obligations, approvals, signatures, clauses, requests, PDF designs, assets, assignments.

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
- “Create a ticket for this incident after I confirm.”
- “Add an internal note to this ticket.”
- “Show contract obligations due this month.”
- “Submit this contract for approval after confirmation.”
- “Download this ticket report to `/tmp/report.xlsx`.”

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `XALANTIS_API_KEY` | Yes | Tenant API key used for Xalantis `/api/v1` requests. |

## Security notes

- The MCP server does not bypass Xalantis backend permissions, plan gates, tenant scoping or rate limits.
- Destructive and externally visible actions require `confirm: true`.
- File downloads can contain sensitive tenant data; use `output_path` carefully.
- API keys should be stored in the MCP client environment configuration, not in prompts.

## Development

```bash
npm ci
npm run lint
npm run build
```

## License

MIT
