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

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

const uuid = z.string().describe('UUID')
const jsonRecord = z.record(z.unknown())
const pagination = {
  page: z.number().int().min(1).optional().describe('Page number'),
  per_page: z.number().int().min(1).max(100).optional().describe('Results per page'),
}

function text(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function error(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function requireConfirmation(confirm: boolean | undefined, action: string): void {
  if (confirm !== true) {
    throw new Error(`Confirmation required before ${action}. Call this tool again with confirm=true after the user explicitly confirms.`)
  }
}

async function call(method: string, path: string, body?: unknown, params?: Record<string, unknown>): Promise<ToolResult> {
  try {
    const result = await apiRequest(API_KEY, method, path, body, params)
    return text(result)
  } catch (e) {
    if (e instanceof ApiError && e.details) {
      return error(`Validation failed: ${JSON.stringify(e.details)}`)
    }

    return error(e instanceof Error ? e.message : 'Unknown error')
  }
}

function assertTicket(uuidValue: string): void {
  assertUuid(uuidValue, 'ticket uuid')
}

// ─── Core tickets ──────────────────────────────────────────

server.tool(
  'list_tickets',
  'List support tickets with optional filters and pagination.',
  {
    status: z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']).optional().describe('Filter by status'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Filter by priority'),
    search: z.string().optional().describe('Search in subject and description'),
    requester_email: z.string().optional().describe('Filter by requester email'),
    sort_by: z.enum(['created_at', 'updated_at', 'priority', 'status', 'due_at', 'reference']).optional().describe('Sort field'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction'),
    ...pagination,
  },
  async (params) => call('GET', '/tickets', undefined, params),
)

server.tool(
  'get_ticket',
  'Get a single ticket by UUID.',
  { uuid: uuid.describe('Ticket UUID') },
  async ({ uuid }) => {
    assertTicket(uuid)
    return call('GET', `/tickets/${uuid}`)
  },
)

server.tool(
  'create_ticket',
  'Create a new support ticket. The assistant/client should ask for user confirmation before creating user-visible tickets.',
  {
    subject: z.string().min(1).max(255).describe('Ticket subject'),
    description: z.string().min(1).describe('Ticket description'),
    requester_email: z.string().email().describe('Email of the person reporting the issue'),
    requester_name: z.string().optional().describe('Name of the requester'),
    type: z.enum(['incident', 'problem', 'support']).optional().describe('Ticket type; recommended for explicit routing'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('Priority level'),
    category_slug: z.string().optional().describe('Category slug'),
    channel: z.enum(['api', 'email', 'phone', 'chat', 'web', 'widget']).optional().describe('Channel source'),
    confirm: z.boolean().optional().describe('Set true only after explicit user confirmation'),
  },
  async ({ confirm, ...params }) => {
    requireConfirmation(confirm, 'creating a ticket')
    return call('POST', '/tickets', params)
  },
)

server.tool(
  'update_ticket',
  'Update an existing ticket. Requires confirmation for status/assignee/priority changes that affect operations.',
  {
    uuid: uuid.describe('Ticket UUID'),
    subject: z.string().min(1).max(255).optional().describe('New subject'),
    description: z.string().min(1).optional().describe('New description'),
    status: z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']).optional().describe('New status'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().describe('New priority'),
    category_slug: z.string().optional().describe('Category slug'),
    assignee_id: z.number().int().optional().describe('Assign to agent by ID'),
    due_at: z.string().optional().describe('SLA due date (ISO 8601)'),
    confirm: z.boolean().optional().describe('Set true after explicit confirmation for impactful updates'),
  },
  async ({ uuid, confirm, ...data }) => {
    assertTicket(uuid)
    if (data.status || data.priority || data.assignee_id) {
      requireConfirmation(confirm, 'updating ticket status, priority or assignee')
    }
    return call('PATCH', `/tickets/${uuid}`, data)
  },
)

server.tool(
  'get_ticket_metrics',
  'Get support ticket metrics.',
  {
    from: z.string().optional().describe('Start date'),
    to: z.string().optional().describe('End date'),
    group_by: z.string().optional().describe('Metric grouping'),
  },
  async (params) => call('GET', '/tickets/metrics', undefined, params),
)

server.tool(
  'list_ticket_activities',
  'List activity history for a ticket.',
  { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination },
  async ({ ticket_uuid, ...params }) => {
    assertTicket(ticket_uuid)
    return call('GET', `/tickets/${ticket_uuid}/activities`, undefined, params)
  },
)

// ─── Replies ───────────────────────────────────────────────

server.tool(
  'list_ticket_replies',
  'List all replies and notes for a ticket.',
  { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination },
  async ({ ticket_uuid, ...params }) => {
    assertTicket(ticket_uuid)
    return call('GET', `/tickets/${ticket_uuid}/replies`, undefined, params)
  },
)

server.tool(
  'reply_to_ticket',
  'Add a reply or internal note to a ticket. Public replies should be confirmed by the user first.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    content: z.string().min(1).describe('Reply content'),
    is_internal: z.boolean().optional().describe('Set true for an internal note'),
    confirm: z.boolean().optional().describe('Set true after explicit confirmation for public replies'),
  },
  async ({ ticket_uuid, confirm, ...data }) => {
    assertTicket(ticket_uuid)
    if (data.is_internal !== true) {
      requireConfirmation(confirm, 'sending a public ticket reply')
    }
    return call('POST', `/tickets/${ticket_uuid}/replies`, data)
  },
)

server.tool(
  'update_ticket_reply',
  'Update a ticket reply or internal note.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    reply_uuid: uuid.describe('Reply UUID'),
    content: z.string().min(1).describe('Updated content'),
    confirm: z.boolean().optional().describe('Set true after explicit user confirmation'),
  },
  async ({ ticket_uuid, reply_uuid, confirm, ...data }) => {
    assertTicket(ticket_uuid)
    assertUuid(reply_uuid, 'ticket reply uuid')
    requireConfirmation(confirm, 'updating a ticket reply')
    return call('PATCH', `/tickets/${ticket_uuid}/replies/${reply_uuid}`, data)
  },
)

server.tool(
  'delete_ticket_reply',
  'Delete a ticket reply. Destructive: requires explicit confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    reply_uuid: uuid.describe('Reply UUID'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, reply_uuid, confirm }) => {
    assertTicket(ticket_uuid)
    assertUuid(reply_uuid, 'ticket reply uuid')
    requireConfirmation(confirm, 'deleting a ticket reply')
    return call('DELETE', `/tickets/${ticket_uuid}/replies/${reply_uuid}`)
  },
)

// ─── Links, watchers and time entries ──────────────────────

server.tool(
  'list_ticket_links',
  'List links attached to a ticket.',
  { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination },
  async ({ ticket_uuid, ...params }) => {
    assertTicket(ticket_uuid)
    return call('GET', `/tickets/${ticket_uuid}/links`, undefined, params)
  },
)

server.tool(
  'link_ticket',
  'Link a ticket to another ticket or object. Requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    data: jsonRecord.describe('Backend link payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'linking a ticket')
    return call('POST', `/tickets/${ticket_uuid}/links`, data)
  },
)

server.tool(
  'unlink_ticket',
  'Remove a ticket link. Destructive: requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    link_uuid: uuid.describe('Link UUID'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, link_uuid, confirm }) => {
    assertTicket(ticket_uuid)
    assertUuid(link_uuid, 'ticket link uuid')
    requireConfirmation(confirm, 'unlinking a ticket')
    return call('DELETE', `/tickets/${ticket_uuid}/links/${link_uuid}`)
  },
)

server.tool(
  'list_ticket_time_entries',
  'List time entries for a ticket.',
  { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination },
  async ({ ticket_uuid, ...params }) => {
    assertTicket(ticket_uuid)
    return call('GET', `/tickets/${ticket_uuid}/time-entries`, undefined, params)
  },
)

server.tool(
  'create_ticket_time_entry',
  'Create a time entry on a ticket. Requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    data: jsonRecord.describe('Time entry payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'creating a ticket time entry')
    return call('POST', `/tickets/${ticket_uuid}/time-entries`, data)
  },
)

server.tool(
  'list_ticket_watchers',
  'List watchers for a ticket.',
  { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination },
  async ({ ticket_uuid, ...params }) => {
    assertTicket(ticket_uuid)
    return call('GET', `/tickets/${ticket_uuid}/watchers`, undefined, params)
  },
)

server.tool(
  'toggle_ticket_watcher',
  'Add or remove a ticket watcher. Requires confirmation because it changes notifications.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    data: jsonRecord.describe('Watcher payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'changing ticket watchers')
    return call('POST', `/tickets/${ticket_uuid}/watchers/toggle`, data)
  },
)

// ─── Service Desk actions ──────────────────────────────────

server.tool(
  'triage_ticket',
  'Run or mark triage for a ticket. Requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    data: jsonRecord.optional().describe('Optional triage payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'triaging a ticket')
    return call('POST', `/tickets/${ticket_uuid}/triage`, data ?? {})
  },
)

server.tool(
  'escalate_ticket',
  'Escalate a ticket. Requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    data: jsonRecord.optional().describe('Optional escalation payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'escalating a ticket')
    return call('POST', `/tickets/${ticket_uuid}/escalate`, data ?? {})
  },
)

server.tool(
  'deescalate_ticket',
  'De-escalate a ticket. Requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    data: jsonRecord.optional().describe('Optional de-escalation payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'de-escalating a ticket')
    return call('POST', `/tickets/${ticket_uuid}/de-escalate`, data ?? {})
  },
)

// ─── Service requests and catalog ──────────────────────────

server.tool(
  'list_service_catalog',
  'List service catalog items visible to the API key.',
  { search: z.string().optional(), category: z.string().optional(), ...pagination },
  async (params) => call('GET', '/service-catalog', undefined, params),
)

server.tool(
  'create_service_request_from_catalog',
  'Create a service request from a catalog item. Requires confirmation.',
  {
    catalog_item_uuid: uuid.describe('Service catalog item UUID'),
    data: jsonRecord.describe('Service request payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ catalog_item_uuid, data, confirm }) => {
    assertUuid(catalog_item_uuid, 'service catalog item uuid')
    requireConfirmation(confirm, 'creating a service request')
    return call('POST', `/service-catalog/${catalog_item_uuid}/requests`, data)
  },
)

for (const [toolName, pathSegment, description] of [
  ['approve_service_request', 'approve', 'Approve a service request. Requires confirmation.'],
  ['reject_service_request', 'reject', 'Reject a service request. Requires confirmation.'],
  ['fulfill_service_request', 'fulfill', 'Fulfill a service request. Requires confirmation.'],
  ['reopen_service_request', 'reopen', 'Reopen a service request. Requires confirmation.'],
] as const) {
  server.tool(
    toolName,
    description,
    {
      ticket_uuid: uuid.describe('Ticket UUID'),
      data: jsonRecord.optional().describe('Optional action payload'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ ticket_uuid, data, confirm }) => {
      assertTicket(ticket_uuid)
      requireConfirmation(confirm, `${pathSegment} service request`)
      return call('POST', `/tickets/${ticket_uuid}/service-request/${pathSegment}`, data ?? {})
    },
  )
}

// ─── Support configuration reads/actions ───────────────────

server.tool(
  'list_ticket_categories',
  'List ticket categories.',
  { ...pagination, search: z.string().optional() },
  async (params) => call('GET', '/ticket-categories', undefined, params),
)

server.tool(
  'list_ticket_tags',
  'List ticket tags.',
  { ...pagination, search: z.string().optional() },
  async (params) => call('GET', '/ticket-tags', undefined, params),
)

server.tool(
  'list_sla_breaches',
  'List SLA breaches.',
  { ...pagination, status: z.string().optional() },
  async (params) => call('GET', '/sla-breaches', undefined, params),
)

server.tool(
  'acknowledge_sla_breach',
  'Acknowledge an SLA breach. Requires confirmation.',
  {
    breach_uuid: uuid.describe('SLA breach UUID'),
    data: jsonRecord.optional().describe('Optional acknowledgement payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ breach_uuid, data, confirm }) => {
    assertUuid(breach_uuid, 'SLA breach uuid')
    requireConfirmation(confirm, 'acknowledging an SLA breach')
    return call('POST', `/sla-breaches/${breach_uuid}/acknowledge`, data ?? {})
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
