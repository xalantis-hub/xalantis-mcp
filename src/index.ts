#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { apiRequest, assertUuid, ApiError } from './api.js'

const API_KEY = process.env.XALANTIS_API_KEY || ''

if (!API_KEY) {
  console.error('Error: XALANTIS_API_KEY environment variable is required')
  process.exit(1)
}

const server = new McpServer({
  name: 'xalantis',
  version: '0.1.0',
})

// ─── Helper ────────────────────────────────────────────────

function text(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function error(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// ─── list_tickets ──────────────────────────────────────────

server.tool(
  'list_tickets',
  'List support tickets with optional filters and pagination',
  {
    status: z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']).optional().describe('Filter by status'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Filter by priority'),
    search: z.string().optional().describe('Search in subject and description'),
    requester_email: z.string().optional().describe('Filter by requester email'),
    sort_by: z.enum(['created_at', 'updated_at', 'priority', 'status', 'due_at', 'reference']).optional().describe('Sort field'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
    page: z.number().int().min(1).optional().describe('Page number'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page (max 100)'),
  },
  async (params) => {
    try {
      const result = await apiRequest(API_KEY, 'GET', '/tickets', undefined, params)
      return text(result)
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Unknown error')
    }
  },
)

// ─── get_ticket ────────────────────────────────────────────

server.tool(
  'get_ticket',
  'Get a single ticket by UUID',
  {
    uuid: z.string().describe('Ticket UUID'),
  },
  async ({ uuid }) => {
    try {
      assertUuid(uuid, 'ticket uuid')
      const result = await apiRequest(API_KEY, 'GET', `/tickets/${uuid}`)
      return text(result)
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Unknown error')
    }
  },
)

// ─── create_ticket ─────────────────────────────────────────

server.tool(
  'create_ticket',
  'Create a new support ticket',
  {
    subject: z.string().min(1).max(255).describe('Ticket subject'),
    description: z.string().min(1).describe('Ticket description'),
    requester_email: z.string().email().describe('Email of the person reporting the issue'),
    requester_name: z.string().optional().describe('Name of the requester'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Priority level (default: medium)'),
    category_slug: z.string().optional().describe('Category slug'),
    channel: z.enum(['api', 'email', 'phone', 'chat', 'web', 'widget']).optional().describe('Channel source'),
  },
  async (params) => {
    try {
      const result = await apiRequest(API_KEY, 'POST', '/tickets', params)
      return text(result)
    } catch (e) {
      if (e instanceof ApiError && e.details) {
        return error(`Validation failed: ${JSON.stringify(e.details)}`)
      }
      return error(e instanceof Error ? e.message : 'Unknown error')
    }
  },
)

// ─── update_ticket ─────────────────────────────────────────

server.tool(
  'update_ticket',
  'Update an existing ticket (status, priority, subject, etc.)',
  {
    uuid: z.string().describe('Ticket UUID'),
    subject: z.string().min(1).max(255).optional().describe('New subject'),
    description: z.string().min(1).optional().describe('New description'),
    status: z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']).optional().describe('New status'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('New priority'),
    category_slug: z.string().optional().describe('Category slug'),
    assignee_id: z.number().int().optional().describe('Assign to agent by ID'),
    due_at: z.string().optional().describe('SLA due date (ISO 8601)'),
  },
  async ({ uuid, ...data }) => {
    try {
      assertUuid(uuid, 'ticket uuid')
      const result = await apiRequest(API_KEY, 'PATCH', `/tickets/${uuid}`, data)
      return text(result)
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Unknown error')
    }
  },
)

// ─── reply_to_ticket ───────────────────────────────────────

server.tool(
  'reply_to_ticket',
  'Add a reply or internal note to a ticket',
  {
    ticket_uuid: z.string().describe('Ticket UUID'),
    content: z.string().min(1).describe('Reply content'),
    is_internal: z.boolean().optional().describe('Set to true for an internal note (not visible to requester)'),
  },
  async ({ ticket_uuid, ...data }) => {
    try {
      assertUuid(ticket_uuid, 'ticket uuid')
      const result = await apiRequest(API_KEY, 'POST', `/tickets/${ticket_uuid}/replies`, data)
      return text(result)
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Unknown error')
    }
  },
)

// ─── list_ticket_replies ───────────────────────────────────

server.tool(
  'list_ticket_replies',
  'List all replies and notes for a ticket',
  {
    ticket_uuid: z.string().describe('Ticket UUID'),
    page: z.number().int().min(1).optional().describe('Page number'),
    per_page: z.number().int().min(1).max(100).optional().describe('Results per page'),
  },
  async ({ ticket_uuid, ...params }) => {
    try {
      assertUuid(ticket_uuid, 'ticket uuid')
      const result = await apiRequest(API_KEY, 'GET', `/tickets/${ticket_uuid}/replies`, undefined, params)
      return text(result)
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Unknown error')
    }
  },
)

// ─── Start server ──────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Xalantis MCP server running')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
