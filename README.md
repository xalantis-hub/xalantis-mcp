# @xalantis/mcp-server

MCP server for Xalantis — manage support tickets from Claude, Cursor, and other AI tools.

## Installation

```bash
npm install -g @xalantis/mcp-server
```

## Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

Then set the environment variable `XALANTIS_API_KEY` in your shell.

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

## Available Tools

| Tool | Description |
|------|-------------|
| `list_tickets` | List tickets with filters (status, priority, search, pagination) |
| `get_ticket` | Get a single ticket by UUID |
| `create_ticket` | Create a new support ticket |
| `update_ticket` | Update ticket status, priority, subject, etc. |
| `reply_to_ticket` | Add a reply or internal note |
| `list_ticket_replies` | List all replies for a ticket |

## Examples

Once connected, you can ask your AI assistant:

- "List all open high-priority tickets"
- "Create a ticket about the login bug reported by user@example.com"
- "Mark ticket abc-123 as resolved"
- "Reply to ticket abc-123 saying the fix has been deployed"
- "Show me the replies on ticket abc-123"

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `XALANTIS_API_KEY` | Yes | Your Xalantis API key |

## License

MIT
