#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { apiRequest, apiRawRequest, assertUuid, ApiError } from './api.js'

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

async function downloadFile(path: string, outputPath?: string): Promise<ToolResult> {
  try {
    const response = await apiRawRequest(API_KEY, 'GET', path, undefined, undefined, { Accept: '*/*' })
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
    const disposition = response.headers.get('content-disposition') ?? ''
    const filename = disposition.match(/filename=\"?([^\";]+)\"?/i)?.[1] ?? null
    const bytes = Buffer.from(await response.arrayBuffer())

    if (outputPath) {
      await writeFile(outputPath, bytes)
      return text({ success: true, output_path: outputPath, filename, content_type: contentType, bytes: bytes.length })
    }

    return text({
      success: true,
      filename,
      content_type: contentType,
      bytes: bytes.length,
      base64: bytes.toString('base64'),
    })
  } catch (e) {
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
  'delete_ticket',
  'Delete a ticket. Destructive: requires explicit confirmation.',
  {
    uuid: uuid.describe('Ticket UUID'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ uuid, confirm }) => {
    assertTicket(uuid)
    requireConfirmation(confirm, 'deleting a ticket')
    return call('DELETE', `/tickets/${uuid}`)
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
  'toggle_ticket_tag',
  'Attach or detach a tag on a ticket. Requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    tag_uuid: uuid.describe('Ticket tag UUID'),
    data: jsonRecord.optional().describe('Optional payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, tag_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    assertUuid(tag_uuid, 'ticket tag uuid')
    requireConfirmation(confirm, 'toggling a ticket tag')
    return call('POST', `/tickets/${ticket_uuid}/tags/${tag_uuid}/toggle`, data ?? {})
  },
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

// ─── CRM ───────────────────────────────────────────────────

function registerCrudTools(prefix: string, path: string, label: string, allowDelete = true): void {
  server.tool(
    `list_${prefix}`,
    `List ${label}.`,
    { ...pagination, search: z.string().optional() },
    async (params) => call('GET', path, undefined, params),
  )

  server.tool(
    `get_${prefix.slice(0, -1)}`,
    `Get one ${label} item by UUID.`,
    { item_uuid: uuid.describe(`${label} UUID`) },
    async ({ item_uuid }) => {
      assertUuid(item_uuid, `${label} uuid`)
      return call('GET', `${path}/${item_uuid}`)
    },
  )

  server.tool(
    `create_${prefix.slice(0, -1)}`,
    `Create a ${label} item. Requires confirmation.`,
    {
      data: jsonRecord.describe('Create payload'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ data, confirm }) => {
      requireConfirmation(confirm, `creating ${label}`)
      return call('POST', path, data)
    },
  )

  server.tool(
    `update_${prefix.slice(0, -1)}`,
    `Update a ${label} item. Requires confirmation.`,
    {
      item_uuid: uuid.describe(`${label} UUID`),
      data: jsonRecord.describe('Update payload'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ item_uuid, data, confirm }) => {
      assertUuid(item_uuid, `${label} uuid`)
      requireConfirmation(confirm, `updating ${label}`)
      return call('PATCH', `${path}/${item_uuid}`, data)
    },
  )

  if (allowDelete) {
    server.tool(
      `delete_${prefix.slice(0, -1)}`,
      `Delete a ${label} item. Destructive: requires confirmation.`,
      {
        item_uuid: uuid.describe(`${label} UUID`),
        confirm: z.boolean().describe('Must be true after explicit user confirmation'),
      },
      async ({ item_uuid, confirm }) => {
        assertUuid(item_uuid, `${label} uuid`)
        requireConfirmation(confirm, `deleting ${label}`)
        return call('DELETE', `${path}/${item_uuid}`)
      },
    )
  }
}

// ─── Remaining Support non-binary tools ────────────────────

server.tool(
  'bulk_update_tickets',
  'Run a bulk ticket action. Requires confirmation.',
  {
    data: jsonRecord.describe('Bulk action payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ data, confirm }) => {
    requireConfirmation(confirm, 'running a bulk ticket action')
    return call('POST', '/tickets/bulk', data)
  },
)

server.tool('list_ticket_reports', 'List generated ticket reports.', { ...pagination }, async (params) => call('GET', '/tickets/reports', undefined, params))

server.tool(
  'download_ticket_report',
  'Download a generated ticket report. Returns base64 unless output_path is provided.',
  {
    report_uuid: uuid.describe('Ticket report UUID'),
    output_path: z.string().optional().describe('Optional local output path where the file should be written'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation because reports may contain sensitive data'),
  },
  async ({ report_uuid, output_path, confirm }) => {
    assertUuid(report_uuid, 'ticket report uuid')
    requireConfirmation(confirm, 'downloading a ticket report')
    return downloadFile(`/tickets/reports/${report_uuid}/download`, output_path)
  },
)

server.tool(
  'create_ticket_report',
  'Create a ticket report. Requires confirmation because it may process/export sensitive data.',
  { data: jsonRecord.describe('Report payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ data, confirm }) => {
    requireConfirmation(confirm, 'creating a ticket report')
    return call('POST', '/tickets/report', data)
  },
)

for (const [toolName, segment, actionLabel] of [
  ['archive_ticket', 'archive', 'archiving a ticket'],
  ['unarchive_ticket', 'unarchive', 'unarchiving a ticket'],
  ['restore_independent_ticket', 'restore-independent', 'restoring ticket independence'],
  ['duplicate_ticket', 'duplicate', 'duplicating a ticket'],
  ['duplicate_link_ticket', 'duplicate-link', 'linking a duplicate ticket'],
  ['merge_ticket', 'merge', 'merging a ticket'],
  ['split_ticket', 'split', 'splitting a ticket'],
] as const) {
  server.tool(
    toolName,
    `${actionLabel}. Requires confirmation.`,
    {
      ticket_uuid: uuid.describe('Ticket UUID'),
      data: jsonRecord.optional().describe('Optional action payload'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ ticket_uuid, data, confirm }) => {
      assertTicket(ticket_uuid)
      requireConfirmation(confirm, actionLabel)
      return call('POST', `/tickets/${ticket_uuid}/${segment}`, data ?? {})
    },
  )
}

server.tool('list_ticket_merge_candidates', 'List merge candidates for a ticket.', { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination }, async ({ ticket_uuid, ...params }) => {
  assertTicket(ticket_uuid)
  return call('GET', `/tickets/${ticket_uuid}/merge-candidates`, undefined, params)
})

server.tool('list_ticket_duplicate_candidates', 'List duplicate candidates for a ticket.', { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination }, async ({ ticket_uuid, ...params }) => {
  assertTicket(ticket_uuid)
  return call('GET', `/tickets/${ticket_uuid}/duplicate-candidates`, undefined, params)
})

server.tool('list_ticket_escalation_executions', 'List escalation executions for a ticket.', { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination }, async ({ ticket_uuid, ...params }) => {
  assertTicket(ticket_uuid)
  return call('GET', `/tickets/${ticket_uuid}/escalation-executions`, undefined, params)
})

server.tool('list_ticket_attachments', 'List ticket attachments metadata.', { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination }, async ({ ticket_uuid, ...params }) => {
  assertTicket(ticket_uuid)
  return call('GET', `/tickets/${ticket_uuid}/attachments`, undefined, params)
})

server.tool(
  'upload_ticket_attachment',
  'Upload a local file as a ticket attachment. Requires confirmation.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    file_path: z.string().min(1).describe('Local file path to upload'),
    field_name: z.string().optional().describe('Multipart field name, defaults to file'),
    data: jsonRecord.optional().describe('Optional additional multipart fields'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ ticket_uuid, file_path, field_name, data, confirm }) => {
    try {
      assertTicket(ticket_uuid)
      requireConfirmation(confirm, 'uploading a ticket attachment')
      const form = new FormData()
      form.append(field_name ?? 'file', new Blob([await readFile(file_path)]), basename(file_path))

      for (const [key, value] of Object.entries(data ?? {})) {
        if (value !== undefined && value !== null) {
          form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
        }
      }

      const response = await apiRawRequest(API_KEY, 'POST', `/tickets/${ticket_uuid}/attachments`, form)
      return text(await response.json())
    } catch (e) {
      return error(e instanceof Error ? e.message : 'Unknown error')
    }
  },
)

server.tool(
  'download_ticket_attachment',
  'Download a ticket attachment. Returns base64 unless output_path is provided.',
  {
    ticket_uuid: uuid.describe('Ticket UUID'),
    attachment_uuid: uuid.describe('Attachment UUID'),
    output_path: z.string().optional().describe('Optional local output path where the file should be written'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation because attachments may contain sensitive data'),
  },
  async ({ ticket_uuid, attachment_uuid, output_path, confirm }) => {
    assertTicket(ticket_uuid)
    assertUuid(attachment_uuid, 'ticket attachment uuid')
    requireConfirmation(confirm, 'downloading a ticket attachment')
    return downloadFile(`/tickets/${ticket_uuid}/attachments/${attachment_uuid}/download`, output_path)
  },
)

server.tool(
  'delete_ticket_attachment',
  'Delete a ticket attachment. Destructive: requires confirmation.',
  { ticket_uuid: uuid.describe('Ticket UUID'), attachment_uuid: uuid.describe('Attachment UUID'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ ticket_uuid, attachment_uuid, confirm }) => {
    assertTicket(ticket_uuid)
    assertUuid(attachment_uuid, 'ticket attachment uuid')
    requireConfirmation(confirm, 'deleting a ticket attachment')
    return call('DELETE', `/tickets/${ticket_uuid}/attachments/${attachment_uuid}`)
  },
)

server.tool(
  'retry_ticket_reply',
  'Retry a failed ticket reply. Requires confirmation.',
  { ticket_uuid: uuid.describe('Ticket UUID'), reply_uuid: uuid.describe('Reply UUID'), data: jsonRecord.optional(), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ ticket_uuid, reply_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    assertUuid(reply_uuid, 'ticket reply uuid')
    requireConfirmation(confirm, 'retrying a ticket reply')
    return call('POST', `/tickets/${ticket_uuid}/replies/${reply_uuid}/retry`, data ?? {})
  },
)

for (const [toolName, method, suffix, actionLabel] of [
  ['create_ticket_subtask', 'POST', 'subtasks', 'creating a ticket subtask'],
  ['toggle_ticket_subtask', 'PATCH', 'subtasks/{child}/toggle', 'toggling a ticket subtask'],
  ['delete_ticket_subtask', 'DELETE', 'subtasks/{child}', 'deleting a ticket subtask'],
  ['update_ticket_time_entry', 'PATCH', 'time-entries/{child}', 'updating a ticket time entry'],
  ['delete_ticket_time_entry', 'DELETE', 'time-entries/{child}', 'deleting a ticket time entry'],
] as const) {
  server.tool(
    toolName,
    `${actionLabel}. Requires confirmation.`,
    {
      ticket_uuid: uuid.describe('Ticket UUID'),
      child_uuid: z.string().optional().describe('Subtask or time entry UUID when required'),
      data: jsonRecord.optional().describe('Optional payload'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ ticket_uuid, child_uuid, data, confirm }) => {
      assertTicket(ticket_uuid)
      requireConfirmation(confirm, actionLabel)
      let resolvedSuffix: string = suffix
      if (resolvedSuffix.includes('{child}')) {
        if (!child_uuid) throw new Error('child_uuid is required for this action')
        assertUuid(child_uuid, 'child uuid')
        resolvedSuffix = resolvedSuffix.replace('{child}', child_uuid)
      }
      return call(method, `/tickets/${ticket_uuid}/${resolvedSuffix}`, data ?? {})
    },
  )
}

server.tool(
  'acknowledge_requester_response',
  'Acknowledge requester response on a ticket. Requires confirmation.',
  { ticket_uuid: uuid.describe('Ticket UUID'), data: jsonRecord.optional(), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'acknowledging requester response')
    return call('POST', `/tickets/${ticket_uuid}/requester-response/acknowledge`, data ?? {})
  },
)

server.tool('list_ticket_incident_updates', 'List incident updates for a ticket.', { ticket_uuid: uuid.describe('Ticket UUID'), ...pagination }, async ({ ticket_uuid, ...params }) => {
  assertTicket(ticket_uuid)
  return call('GET', `/tickets/${ticket_uuid}/incident-updates`, undefined, params)
})

server.tool(
  'create_ticket_incident_update',
  'Create an incident update. Requires confirmation.',
  { ticket_uuid: uuid.describe('Ticket UUID'), data: jsonRecord.describe('Incident update payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ ticket_uuid, data, confirm }) => {
    assertTicket(ticket_uuid)
    requireConfirmation(confirm, 'creating an incident update')
    return call('POST', `/tickets/${ticket_uuid}/incident-updates`, data)
  },
)

server.tool('get_ticket_incident_report', 'Get incident report for a ticket.', { ticket_uuid: uuid.describe('Ticket UUID') }, async ({ ticket_uuid }) => {
  assertTicket(ticket_uuid)
  return call('GET', `/tickets/${ticket_uuid}/incident-report`)
})

server.tool('get_archived_ticket_incident_report', 'Get archived incident report for a ticket.', { ticket_uuid: uuid.describe('Ticket UUID') }, async ({ ticket_uuid }) => {
  assertTicket(ticket_uuid)
  return call('GET', `/tickets/${ticket_uuid}/incident-report/archived`)
})

for (const [toolName, method, segment, actionLabel] of [
  ['archive_ticket_incident_report', 'POST', 'incident-report/archive', 'archiving an incident report'],
  ['request_ticket_incident_report_signoff', 'POST', 'incident-report/request-signoff', 'requesting incident report signoff'],
  ['link_ticket_incident_ci', 'POST', 'incident-ci', 'linking incident CI'],
  ['link_ticket_incident_problem', 'POST', 'incident-problem', 'linking incident problem'],
  ['link_ticket_incident_service_component', 'POST', 'incident-service-component', 'linking incident service component'],
  ['update_ticket_incident_publication', 'PATCH', 'incident-publication', 'updating incident publication'],
  ['update_ticket_incident_severity_override', 'PATCH', 'incident-severity-override', 'updating incident severity override'],
  ['update_ticket_incident_closure_review', 'PATCH', 'incident-closure-review', 'updating incident closure review'],
] as const) {
  server.tool(
    toolName,
    `${actionLabel}. Requires confirmation.`,
    { ticket_uuid: uuid.describe('Ticket UUID'), data: jsonRecord.optional().describe('Optional payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
    async ({ ticket_uuid, data, confirm }) => {
      assertTicket(ticket_uuid)
      requireConfirmation(confirm, actionLabel)
      return call(method, `/tickets/${ticket_uuid}/${segment}`, data ?? {})
    },
  )
}

server.tool('get_agent_status', 'Get Service Desk agent status.', { ...pagination }, async (params) => call('GET', '/agents/status', undefined, params))

server.tool(
  'update_agent_status',
  'Update Service Desk agent status. Requires confirmation.',
  { data: jsonRecord.describe('Agent status payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ data, confirm }) => {
    requireConfirmation(confirm, 'updating agent status')
    return call('PATCH', '/agents/status', data)
  },
)

server.tool('admin_list_service_catalog', 'List service catalog administration view.', { ...pagination, search: z.string().optional() }, async (params) => call('GET', '/service-catalog/administration', undefined, params))

server.tool('get_service_catalog_item', 'Get a service catalog item by UUID.', { item_uuid: uuid.describe('Service catalog item UUID') }, async ({ item_uuid }) => {
  assertUuid(item_uuid, 'service catalog item uuid')
  return call('GET', `/service-catalog/${item_uuid}`)
})

for (const [toolName, method, pathTemplate, actionLabel] of [
  ['create_service_catalog_item', 'POST', '/service-catalog', 'creating a service catalog item'],
  ['update_service_catalog_item', 'PATCH', '/service-catalog/{item}', 'updating a service catalog item'],
  ['delete_service_catalog_item', 'DELETE', '/service-catalog/{item}', 'deleting a service catalog item'],
  ['duplicate_service_catalog_item', 'POST', '/service-catalog/{item}/duplicate', 'duplicating a service catalog item'],
  ['toggle_service_catalog_item', 'POST', '/service-catalog/{item}/toggle', 'toggling a service catalog item'],
] as const) {
  server.tool(
    toolName,
    `${actionLabel}. Requires confirmation.`,
    { item_uuid: z.string().optional().describe('Service catalog item UUID when required'), data: jsonRecord.optional(), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
    async ({ item_uuid, data, confirm }) => {
      requireConfirmation(confirm, actionLabel)
      let path: string = pathTemplate
      if (path.includes('{item}')) {
        if (!item_uuid) throw new Error('item_uuid is required for this action')
        assertUuid(item_uuid, 'service catalog item uuid')
        path = path.replace('{item}', item_uuid)
      }
      return call(method, path, data ?? {})
    },
  )
}

registerCrudTools('ticket_reply_templates', '/ticket-reply-templates', 'ticket reply template')
registerCrudTools('ticket_automations', '/ticket-automations', 'ticket automation')

for (const [baseName, path, label] of [
  ['ticket_category', '/ticket-categories', 'ticket category'],
  ['ticket_tag', '/ticket-tags', 'ticket tag'],
  ['sla_policy', '/sla-policies', 'SLA policy'],
] as const) {
  server.tool(
    `create_${baseName}`,
    `Create a ${label}. Requires confirmation.`,
    { data: jsonRecord.describe('Create payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
    async ({ data, confirm }) => {
      requireConfirmation(confirm, `creating ${label}`)
      return call('POST', path, data)
    },
  )
  server.tool(
    `update_${baseName}`,
    `Update a ${label}. Requires confirmation.`,
    { item_uuid: uuid.describe(`${label} UUID`), data: jsonRecord.describe('Update payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
    async ({ item_uuid, data, confirm }) => {
      assertUuid(item_uuid, `${label} uuid`)
      requireConfirmation(confirm, `updating ${label}`)
      return call('PATCH', `${path}/${item_uuid}`, data)
    },
  )
  server.tool(
    `delete_${baseName}`,
    `Delete a ${label}. Destructive: requires confirmation.`,
    { item_uuid: uuid.describe(`${label} UUID`), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
    async ({ item_uuid, confirm }) => {
      assertUuid(item_uuid, `${label} uuid`)
      requireConfirmation(confirm, `deleting ${label}`)
      return call('DELETE', `${path}/${item_uuid}`)
    },
  )
}

server.tool('list_sla_policies', 'List SLA policies.', { ...pagination, search: z.string().optional() }, async (params) => call('GET', '/sla-policies', undefined, params))
server.tool('list_escalation_policies', 'List escalation policies.', { ...pagination, search: z.string().optional() }, async (params) => call('GET', '/escalation-policies', undefined, params))
server.tool(
  'create_escalation_policy',
  'Create an escalation policy. Requires confirmation.',
  { data: jsonRecord.describe('Create payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ data, confirm }) => {
    requireConfirmation(confirm, 'creating escalation policy')
    return call('POST', '/escalation-policies', data)
  },
)
server.tool(
  'update_escalation_policy',
  'Update an escalation policy. Requires confirmation.',
  { policy_uuid: uuid.describe('Escalation policy UUID'), data: jsonRecord.describe('Update payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ policy_uuid, data, confirm }) => {
    assertUuid(policy_uuid, 'escalation policy uuid')
    requireConfirmation(confirm, 'updating escalation policy')
    return call('PATCH', `/escalation-policies/${policy_uuid}`, data)
  },
)

server.tool(
  'reorder_ticket_automations',
  'Reorder ticket automations. Requires confirmation.',
  { data: jsonRecord.describe('Reorder payload'), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
  async ({ data, confirm }) => {
    requireConfirmation(confirm, 'reordering ticket automations')
    return call('POST', '/ticket-automations/reorder', data)
  },
)

server.tool('list_ticket_automation_executions', 'List executions for a ticket automation.', { automation_uuid: uuid.describe('Ticket automation UUID'), ...pagination }, async ({ automation_uuid, ...params }) => {
  assertUuid(automation_uuid, 'ticket automation uuid')
  return call('GET', `/ticket-automations/${automation_uuid}/executions`, undefined, params)
})

for (const [toolName, segment, actionLabel] of [
  ['duplicate_ticket_automation', 'duplicate', 'duplicating ticket automation'],
  ['toggle_ticket_automation', 'toggle', 'toggling ticket automation'],
] as const) {
  server.tool(
    toolName,
    `${actionLabel}. Requires confirmation.`,
    { automation_uuid: uuid.describe('Ticket automation UUID'), data: jsonRecord.optional(), confirm: z.boolean().describe('Must be true after explicit user confirmation') },
    async ({ automation_uuid, data, confirm }) => {
      assertUuid(automation_uuid, 'ticket automation uuid')
      requireConfirmation(confirm, actionLabel)
      return call('POST', `/ticket-automations/${automation_uuid}/${segment}`, data ?? {})
    },
  )
}

registerCrudTools('clients', '/clients', 'client')
registerCrudTools('contacts', '/contacts', 'contact')
registerCrudTools('deals', '/deals', 'deal')

server.tool(
  'list_client_representatives',
  'List representatives for a client.',
  { client_uuid: uuid.describe('Client UUID'), ...pagination },
  async ({ client_uuid, ...params }) => {
    assertUuid(client_uuid, 'client uuid')
    return call('GET', `/clients/${client_uuid}/representatives`, undefined, params)
  },
)

server.tool(
  'create_client_representative',
  'Create a representative for a client. Requires confirmation.',
  {
    client_uuid: uuid.describe('Client UUID'),
    data: jsonRecord.describe('Representative payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ client_uuid, data, confirm }) => {
    assertUuid(client_uuid, 'client uuid')
    requireConfirmation(confirm, 'creating a client representative')
    return call('POST', `/clients/${client_uuid}/representatives`, data)
  },
)

server.tool(
  'list_pipelines',
  'List CRM pipelines.',
  { ...pagination },
  async (params) => call('GET', '/pipelines', undefined, params),
)

// ─── Knowledge, billing and finance ────────────────────────

server.tool(
  'list_knowledge',
  'List knowledge base articles.',
  { ...pagination, search: z.string().optional() },
  async (params) => call('GET', '/knowledge', undefined, params),
)

server.tool(
  'search_knowledge',
  'Search the knowledge base.',
  { ...pagination, q: z.string().optional(), search: z.string().optional() },
  async (params) => call('GET', '/knowledge/search', undefined, params),
)

server.tool(
  'list_knowledge_categories',
  'List knowledge base categories.',
  { ...pagination },
  async (params) => call('GET', '/knowledge/categories', undefined, params),
)

server.tool(
  'get_knowledge_article',
  'Get a knowledge article by identifier or slug.',
  { identifier: z.string().min(1).describe('Article identifier or slug') },
  async ({ identifier }) => call('GET', `/knowledge/${encodeURIComponent(identifier)}`),
)

server.tool(
  'get_billing_subscription',
  'Get the current billing subscription.',
  {},
  async () => call('GET', '/billing/subscription'),
)

server.tool(
  'list_billing_invoices',
  'List billing invoices.',
  { ...pagination },
  async (params) => call('GET', '/billing/invoices', undefined, params),
)

server.tool(
  'get_billing_invoice',
  'Get a billing invoice by UUID.',
  { invoice_uuid: uuid.describe('Billing invoice UUID') },
  async ({ invoice_uuid }) => {
    assertUuid(invoice_uuid, 'billing invoice uuid')
    return call('GET', `/billing/invoices/${invoice_uuid}`)
  },
)

server.tool(
  'list_finance_invoices',
  'List finance invoices.',
  { ...pagination },
  async (params) => call('GET', '/finance/invoices', undefined, params),
)

server.tool(
  'get_finance_invoice',
  'Get a finance invoice by UUID.',
  { invoice_uuid: uuid.describe('Finance invoice UUID') },
  async ({ invoice_uuid }) => {
    assertUuid(invoice_uuid, 'finance invoice uuid')
    return call('GET', `/finance/invoices/${invoice_uuid}`)
  },
)

server.tool(
  'list_finance_expenses',
  'List finance expenses.',
  { ...pagination },
  async (params) => call('GET', '/finance/expenses', undefined, params),
)

server.tool(
  'get_finance_expense',
  'Get a finance expense by UUID.',
  { expense_uuid: uuid.describe('Finance expense UUID') },
  async ({ expense_uuid }) => {
    assertUuid(expense_uuid, 'finance expense uuid')
    return call('GET', `/finance/expenses/${expense_uuid}`)
  },
)

// ─── Contracts ─────────────────────────────────────────────

registerCrudTools('contracts', '/contracts', 'contract')
registerCrudTools('contract_clauses', '/contract-clauses', 'contract clause')
registerCrudTools('contract_pdf_designs', '/contract-pdf-designs', 'contract PDF design')

server.tool(
  'list_contract_comments',
  'List comments for a contract.',
  { contract_uuid: uuid.describe('Contract UUID'), ...pagination },
  async ({ contract_uuid, ...params }) => {
    assertUuid(contract_uuid, 'contract uuid')
    return call('GET', `/contracts/${contract_uuid}/comments`, undefined, params)
  },
)

server.tool(
  'add_contract_comment',
  'Add a comment to a contract. Requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    data: jsonRecord.describe('Comment payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    requireConfirmation(confirm, 'adding a contract comment')
    return call('POST', `/contracts/${contract_uuid}/comments`, data)
  },
)

server.tool(
  'update_contract_comment',
  'Update a contract comment. Requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    comment_uuid: uuid.describe('Comment UUID'),
    data: jsonRecord.describe('Update payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, comment_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    assertUuid(comment_uuid, 'contract comment uuid')
    requireConfirmation(confirm, 'updating a contract comment')
    return call('PATCH', `/contracts/${contract_uuid}/comments/${comment_uuid}`, data)
  },
)

server.tool(
  'delete_contract_comment',
  'Delete a contract comment. Destructive: requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    comment_uuid: uuid.describe('Comment UUID'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, comment_uuid, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    assertUuid(comment_uuid, 'contract comment uuid')
    requireConfirmation(confirm, 'deleting a contract comment')
    return call('DELETE', `/contracts/${contract_uuid}/comments/${comment_uuid}`)
  },
)

server.tool(
  'list_contract_negotiations',
  'List negotiations for a contract.',
  { contract_uuid: uuid.describe('Contract UUID'), ...pagination },
  async ({ contract_uuid, ...params }) => {
    assertUuid(contract_uuid, 'contract uuid')
    return call('GET', `/contracts/${contract_uuid}/negotiations`, undefined, params)
  },
)

server.tool(
  'create_contract_negotiation',
  'Create a contract negotiation entry. Requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    data: jsonRecord.describe('Negotiation payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    requireConfirmation(confirm, 'creating a contract negotiation')
    return call('POST', `/contracts/${contract_uuid}/negotiations`, data)
  },
)

server.tool(
  'resolve_contract_negotiation',
  'Resolve a contract negotiation. Requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    negotiation_uuid: uuid.describe('Negotiation UUID'),
    data: jsonRecord.optional().describe('Optional resolve payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, negotiation_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    assertUuid(negotiation_uuid, 'contract negotiation uuid')
    requireConfirmation(confirm, 'resolving a contract negotiation')
    return call('POST', `/contracts/${contract_uuid}/negotiations/${negotiation_uuid}/resolve`, data ?? {})
  },
)

server.tool(
  'list_contract_obligations',
  'List obligations for a contract.',
  { contract_uuid: uuid.describe('Contract UUID'), ...pagination },
  async ({ contract_uuid, ...params }) => {
    assertUuid(contract_uuid, 'contract uuid')
    return call('GET', `/contracts/${contract_uuid}/obligations`, undefined, params)
  },
)

server.tool(
  'create_contract_obligation',
  'Create a contract obligation. Requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    data: jsonRecord.describe('Obligation payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    requireConfirmation(confirm, 'creating a contract obligation')
    return call('POST', `/contracts/${contract_uuid}/obligations`, data)
  },
)

server.tool(
  'update_contract_obligation',
  'Update a contract obligation. Requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    obligation_uuid: uuid.describe('Obligation UUID'),
    data: jsonRecord.describe('Update payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, obligation_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    assertUuid(obligation_uuid, 'contract obligation uuid')
    requireConfirmation(confirm, 'updating a contract obligation')
    return call('PATCH', `/contracts/${contract_uuid}/obligations/${obligation_uuid}`, data)
  },
)

for (const [toolName, action, description] of [
  ['fulfill_contract_obligation', 'fulfill', 'Fulfill a contract obligation. Requires confirmation.'],
  ['waive_contract_obligation', 'waive', 'Waive a contract obligation. Requires confirmation.'],
] as const) {
  server.tool(
    toolName,
    description,
    {
      contract_uuid: uuid.describe('Contract UUID'),
      obligation_uuid: uuid.describe('Obligation UUID'),
      data: jsonRecord.optional().describe('Optional action payload'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ contract_uuid, obligation_uuid, data, confirm }) => {
      assertUuid(contract_uuid, 'contract uuid')
      assertUuid(obligation_uuid, 'contract obligation uuid')
      requireConfirmation(confirm, `${action} contract obligation`)
      return call('POST', `/contracts/${contract_uuid}/obligations/${obligation_uuid}/${action}`, data ?? {})
    },
  )
}

server.tool(
  'submit_contract_for_approval',
  'Submit a contract for approval. Requires confirmation.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    data: jsonRecord.optional().describe('Optional submission payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    requireConfirmation(confirm, 'submitting a contract for approval')
    return call('POST', `/contracts/${contract_uuid}/submit-for-approval`, data ?? {})
  },
)

server.tool(
  'request_contract_signatures',
  'Request signatures for a contract. Requires confirmation because it may notify signers.',
  {
    contract_uuid: uuid.describe('Contract UUID'),
    data: jsonRecord.optional().describe('Optional signature request payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ contract_uuid, data, confirm }) => {
    assertUuid(contract_uuid, 'contract uuid')
    requireConfirmation(confirm, 'requesting contract signatures')
    return call('POST', `/contracts/${contract_uuid}/request-signatures`, data ?? {})
  },
)

server.tool(
  'list_contract_requests',
  'List contract requests.',
  { ...pagination, search: z.string().optional() },
  async (params) => call('GET', '/contract-requests', undefined, params),
)

server.tool(
  'create_contract_request',
  'Create a contract request. Requires confirmation.',
  {
    data: jsonRecord.describe('Contract request payload'),
    confirm: z.boolean().describe('Must be true after explicit user confirmation'),
  },
  async ({ data, confirm }) => {
    requireConfirmation(confirm, 'creating a contract request')
    return call('POST', '/contract-requests', data)
  },
)

server.tool(
  'get_contract_request',
  'Get a contract request by UUID.',
  { request_uuid: uuid.describe('Contract request UUID') },
  async ({ request_uuid }) => {
    assertUuid(request_uuid, 'contract request uuid')
    return call('GET', `/contract-requests/${request_uuid}`)
  },
)

for (const [toolName, pathSegment, actionLabel] of [
  ['add_contract_pdf_design_asset', 'assets', 'adding a contract PDF design asset'],
  ['add_contract_pdf_design_assignment', 'assignments', 'adding a contract PDF design assignment'],
] as const) {
  server.tool(
    toolName,
    `${actionLabel}. Requires confirmation.`,
    {
      design_uuid: uuid.describe('Contract PDF design UUID'),
      data: jsonRecord.describe('Payload'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ design_uuid, data, confirm }) => {
      assertUuid(design_uuid, 'contract PDF design uuid')
      requireConfirmation(confirm, actionLabel)
      return call('POST', `/contract-pdf-designs/${design_uuid}/${pathSegment}`, data)
    },
  )
}

for (const [toolName, pathSegment, childLabel, actionLabel] of [
  ['delete_contract_pdf_design_asset', 'assets', 'asset_uuid', 'deleting a contract PDF design asset'],
  ['delete_contract_pdf_design_assignment', 'assignments', 'assignment_uuid', 'deleting a contract PDF design assignment'],
] as const) {
  server.tool(
    toolName,
    `${actionLabel}. Destructive: requires confirmation.`,
    {
      design_uuid: uuid.describe('Contract PDF design UUID'),
      child_uuid: uuid.describe(childLabel),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    async ({ design_uuid, child_uuid, confirm }) => {
      assertUuid(design_uuid, 'contract PDF design uuid')
      assertUuid(child_uuid, childLabel)
      requireConfirmation(confirm, actionLabel)
      return call('DELETE', `/contract-pdf-designs/${design_uuid}/${pathSegment}/${child_uuid}`)
    },
  )
}

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
