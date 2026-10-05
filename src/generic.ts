/**
 * Generic access to every public API v1 operation, driven by the bundled
 * OpenAPI spec: search → describe → read (GET) or call (writes). Covers the
 * operations without a dedicated tool (projects, compliance, signature
 * envelopes, contract referentials, CRM imports…) and new ones as soon as the
 * spec is refreshed.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { apiRawRequest, ApiError } from './api.js'
import type { Catalog, Operation } from './openapi.js'
import { error, requireConfirmation, text, type ToolResult } from './result.js'

/**
 * Text responses above this size flood the model's context: the tool asks for
 * pagination or save_to instead of returning them.
 */
export const MAX_TEXT_BYTES = 200_000

const record = z.record(z.unknown())

const readParams = {
  operation_id: z.string().min(1).describe('operation_id returned by search_operations'),
  path_params: record.optional().describe('Path parameters, e.g. {"projectUuid": "…"}'),
  query: record.optional().describe('Query parameters. Arrays are sent as repeated name[] values.'),
  save_to: z.string().optional().describe('Local file path where the response body is written instead of being returned'),
}

export function registerGenericTools(server: McpServer, apiKey: string, catalog: Catalog): void {
  const areas = catalog.areas().map(({ area }) => area)

  server.tool(
    'search_operations',
    `Step 1/3 for any Xalantis API operation without a dedicated tool (projects and tasks, compliance cases, signature envelopes, contract referentials, CRM imports…). ` +
      `Searches the ${catalog.size} operations of the public API by keywords (all required, accents ignored; summaries are in French, e.g. "tâche commentaire"), area and HTTP method. ` +
      'Without any filter, lists the areas. Next: describe_operation.',
    {
      query: z.string().optional().describe('Keywords, all required, e.g. "projects tasks" or "tâche statut"'),
      area: z.enum(areas as [string, ...string[]]).optional().describe('Functional area (OpenAPI tag)'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method'),
    },
    { readOnlyHint: true },
    async ({ query, area, method }) => {
      if (!query && !area && !method) {
        return text({ api_contract: catalog.version, areas: catalog.areas() })
      }
      const { operations, total } = catalog.search(query, area, method)
      return text({
        total,
        operations,
        ...(total > operations.length
          ? { hint: `${total} operations match, ${operations.length} shown: refine query, area or method.` }
          : {}),
      })
    },
  )

  server.tool(
    'describe_operation',
    'Step 2/3: path, query and header parameters, body schema and required scopes of one operation. Next: read_operation (GET) or call_operation (writes).',
    { operation_id: readParams.operation_id },
    { readOnlyHint: true },
    async ({ operation_id }) => {
      try {
        return text(catalog.describe(operation_id))
      } catch (e) {
        return error(e instanceof Error ? e.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'read_operation',
    'Step 3/3 for reads: runs a GET operation described by describe_operation. Never modifies data. Binary responses (exports, documents) are written to a local file.',
    readParams,
    { readOnlyHint: true },
    async (args) => run(apiKey, catalog, args, 'read'),
  )

  server.tool(
    'call_operation',
    'Step 3/3 for writes: runs a POST, PUT, PATCH or DELETE operation described by describe_operation. ' +
      'Can create, change or delete data within the API key scopes: requires confirm=true after explicit user confirmation. ' +
      'An Idempotency-Key is generated unless one is passed in headers; reuse it only to retry the exact same request.',
    {
      ...readParams,
      headers: record.optional().describe('Headers declared by the operation (If-Match, Idempotency-Key)'),
      body: record.optional().describe('JSON body, or the text fields of a multipart operation'),
      files: record.optional().describe('Multipart operations only: field name → local file path, or list of paths for array fields'),
      confirm: z.boolean().describe('Must be true after explicit user confirmation'),
    },
    { destructiveHint: true },
    async ({ confirm, ...args }) => {
      requireConfirmation(confirm, 'calling a write operation')
      return run(apiKey, catalog, args, 'write')
    },
  )
}

interface RunArgs {
  operation_id: string
  path_params?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
  body?: Record<string, unknown>
  files?: Record<string, unknown>
  save_to?: string
}

async function run(apiKey: string, catalog: Catalog, args: RunArgs, mode: 'read' | 'write'): Promise<ToolResult> {
  try {
    const op = catalog.get(args.operation_id)
    if (!op) throw new Error(`Unknown operation: ${args.operation_id}. Use search_operations to find a valid operation_id.`)
    if (mode === 'read' && op.method !== 'GET') throw new Error(`${op.id} is a ${op.method} operation: use call_operation.`)
    if (mode === 'write' && op.method === 'GET') throw new Error(`${op.id} is a read: use read_operation.`)

    const path = buildPath(op, args.path_params ?? {})
    const query = checkQuery(op, args.query ?? {})
    // Downloads and CSV exports answer non-JSON bodies; JSON stays preferred for errors.
    const headers = { Accept: 'application/json, */*;q=0.8', ...buildHeaders(op, args.headers ?? {}) }
    const body = await buildBody(op, args.body, args.files, headers)

    const response = await apiRawRequest(apiKey, op.method, path, body, query, headers)
    return await readResponse(op, response, args.save_to)
  } catch (e) {
    if (e instanceof ApiError) {
      return error(`${e.message} (HTTP ${e.status}, ${e.code})${e.details ? `\n${JSON.stringify(e.details)}` : ''}`)
    }
    return error(e instanceof Error ? e.message : 'Unknown error')
  }
}

export function buildPath(op: Operation, values: Record<string, unknown>): string {
  const declared = op.params.filter((p) => p.in === 'path').map((p) => p.name)
  const unknown = Object.keys(values).filter((name) => !declared.includes(name))
  if (unknown.length) throw new Error(`Unknown path parameter(s) for ${op.id}: ${unknown.join(', ')}. Expected: ${declared.join(', ') || 'none'}.`)

  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name]
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Missing path parameter for ${op.id}: ${name}`)
    const segment = String(value).trim()
    if (!segment || segment === '.' || segment === '..') throw new Error(`Invalid path parameter ${name}: "${segment}"`)
    return encodeURIComponent(segment)
  })
}

/** Accepts `status` for a declared `status[]`, and `custom_fields` for `custom_fields[key]`. */
export function checkQuery(op: Operation, values: Record<string, unknown>): Record<string, unknown> {
  const declared = op.params.filter((p) => p.in === 'query')
  const base = (name: string) => name.replace(/\[.*$/, '')
  const unknown = Object.keys(values).filter((key) => !declared.some((p) => base(p.name) === base(key)))
  if (unknown.length) {
    throw new Error(`Unknown query parameter(s) for ${op.id}: ${unknown.join(', ')}. Expected: ${declared.map((p) => p.name).join(', ') || 'none'}.`)
  }
  const missing = declared.filter((p) => p.required && !Object.keys(values).some((key) => base(key) === base(p.name)))
  if (missing.length) throw new Error(`Missing required query parameter(s): ${missing.map((p) => p.name).join(', ')}`)

  // A single value given for an array parameter still goes out as name[].
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const isArray = declared.some((p) => p.name === `${base(key)}[]`)
      return [key, isArray && !Array.isArray(value) && value !== undefined && value !== null ? [value] : value]
    }),
  )
}

export function buildHeaders(op: Operation, values: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    const param = op.params.find((p) => p.in === 'header' && p.name.toLowerCase() === key.toLowerCase())
    if (!param) throw new Error(`Header not allowed for ${op.id}: ${key}`)
    if (value !== undefined && value !== null && String(value).trim()) headers[param.name] = String(value).trim()
  }
  return headers
}

async function buildBody(
  op: Operation,
  body: Record<string, unknown> | undefined,
  files: Record<string, unknown> | undefined,
  headers: Record<string, string>,
): Promise<BodyInit | undefined> {
  const hasFiles = files && Object.keys(files).length > 0

  if (op.bodyType === 'multipart/form-data') {
    const properties = (op.bodySchema?.properties ?? {}) as Record<string, { type?: string }>
    const form = new FormData()
    for (const [key, value] of Object.entries(body ?? {})) {
      appendField(form, key, value)
    }
    for (const [field, value] of Object.entries(files ?? {})) {
      const property = properties[field]
      if (!property) throw new Error(`Unknown file field for ${op.id}: ${field}. Fields: ${Object.keys(properties).join(', ')}`)
      const paths = Array.isArray(value) ? value : [value]
      if (paths.length > 1 && property.type !== 'array') throw new Error(`File field ${field} accepts a single file`)
      for (const path of paths) {
        if (typeof path !== 'string' || !path) throw new Error(`File field ${field}: expected a local file path`)
        form.append(property.type === 'array' ? `${field}[]` : field, new Blob([await readFile(path)]), basename(path))
      }
    }
    return form
  }

  if (hasFiles) throw new Error(`${op.id} does not accept files`)
  if (body === undefined) return undefined
  if (!op.bodyType && op.method === 'GET') throw new Error(`${op.id} does not accept a body`)

  headers['Content-Type'] = 'application/json'
  return JSON.stringify(body)
}

function appendField(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) appendField(form, `${key}[]`, item)
  } else if (typeof value === 'object') {
    for (const [sub, item] of Object.entries(value as Record<string, unknown>)) appendField(form, `${key}[${sub}]`, item)
  } else {
    form.append(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  }
}

async function readResponse(op: Operation, response: Response, saveTo: string | undefined): Promise<ToolResult> {
  const contentType = response.headers.get('content-type') ?? ''
  const bytes = Buffer.from(await response.arrayBuffer())
  const isText = /json|^text\//i.test(contentType)

  if (bytes.length === 0) return text({ success: true, status: response.status, data: null })

  if (isText && !saveTo) {
    if (bytes.length > MAX_TEXT_BYTES) {
      return error(
        `Response too large (${bytes.length} bytes, limit ${MAX_TEXT_BYTES}): paginate (per_page), narrow the filters, or pass save_to to write it to a file.`,
      )
    }
    const body = bytes.toString('utf8')
    try {
      return text(JSON.parse(body))
    } catch {
      return { content: [{ type: 'text', text: body }] }
    }
  }

  const disposition = response.headers.get('content-disposition') ?? ''
  const filename = basename(disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? '') || `${op.id}.bin`
  const target = saveTo ?? join(tmpdir(), `xalantis-${Date.now()}-${filename}`)
  await writeFile(target, bytes)
  return text({ success: true, saved_to: target, filename, content_type: contentType, bytes: bytes.length })
}
