// Calls every registered tool with generated arguments against a fake fetch,
// then checks each HTTP request against the bundled OpenAPI spec: a tool that
// targets a route the API does not serve fails here instead of in production.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const UUID = '11111111-1111-4111-8111-111111111111'
const dir = mkdtempSync(join(tmpdir(), 'xalantis-mcp-test-'))
const FILE = join(dir, 'fixture.txt')
writeFileSync(FILE, 'fixture')

const tools = []
McpServer.prototype.tool = function (name, description, shape, ...rest) {
  tools.push({ name, shape, handler: rest.at(-1) })
}
McpServer.prototype.connect = async () => {}

const requests = []
let current
globalThis.fetch = async (url, init = {}) => {
  const headers = init.headers ?? {}
  requests.push({ tool: current, method: init.method ?? 'GET', url: new URL(url), headers })
  return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
}

process.env.XALANTIS_API_KEY = 'sk_test'
await import('../build/index.js')

const spec = JSON.parse(readFileSync(new URL('../openapi/xalantis-openapi.json', import.meta.url), 'utf8'))
const routes = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.keys(item).map((method) => ({
    method: method.toUpperCase(),
    pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  })),
)

function sample(type, key) {
  const def = type?._def ?? {}
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return sample(def.innerType, key)
    case 'ZodEffects':
      return sample(def.schema, key)
    case 'ZodString':
      if (/save_to|output/i.test(key)) return join(dir, `out-${key}`)
      if (/path/i.test(key)) return FILE
      if (def.checks?.some((c) => c.kind === 'email')) return 'jane@example.com'
      return /uuid/i.test(key) || /UUID/.test(type.description ?? '') ? UUID : 'sample'
    case 'ZodEnum':
      return def.values[0]
    case 'ZodNumber':
      return 1
    case 'ZodBoolean':
      return true
    case 'ZodArray':
      return [sample(def.type, key)]
    case 'ZodObject':
      return Object.fromEntries(Object.entries(type.shape).map(([k, v]) => [k, sample(v, k)]))
    default:
      return {}
  }
}

const generic = new Set(['search_operations', 'describe_operation', 'read_operation', 'call_operation'])

for (const tool of tools) {
  current = tool.name
  const args = Object.fromEntries(Object.entries(tool.shape ?? {}).map(([k, v]) => [k, sample(v, k)]))
  if (tool.name === 'read_operation') Object.assign(args, { operation_id: 'get_projects_By_projectUuid_tasks', path_params: { projectUuid: UUID }, query: {} })
  if (tool.name === 'call_operation') Object.assign(args, { operation_id: 'post_projects_By_projectUuid_tasks', path_params: { projectUuid: UUID }, query: {}, headers: {}, files: {}, body: { title: 'Test' } })
  if (tool.name === 'describe_operation') args.operation_id = 'post_projects'
  await tool.handler(args, {})
}

test('registers the dedicated, project and generic tools with unique names', () => {
  const names = tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of ['list_tickets', 'list_projects', 'create_project_task', ...generic]) assert.ok(names.includes(name), name)
})

test('every tool except search/describe sends at least one request', () => {
  const silent = tools.filter((t) => !['search_operations', 'describe_operation'].includes(t.name) && !requests.some((r) => r.tool === t.name))
  assert.deepEqual(silent.map((t) => t.name), [])
})

test('every request targets a route of the public API', () => {
  const unknown = requests
    .filter((r) => !routes.some((route) => route.method === r.method && route.pattern.test(r.url.pathname.replace(/^\/api\/v1/, ''))))
    .map((r) => `${r.tool}: ${r.method} ${r.url.pathname}`)
  assert.deepEqual(unknown, [])
})

test('every write sends an Idempotency-Key', () => {
  const missing = requests
    .filter((r) => r.method !== 'GET' && !Object.keys(r.headers).some((h) => h.toLowerCase() === 'idempotency-key'))
    .map((r) => r.tool)
  assert.deepEqual(missing, [])
})

test('list_project_tasks repeats array filters and sends booleans as 1/0', () => {
  const request = requests.find((r) => r.tool === 'list_project_tasks')
  assert.deepEqual(request.url.searchParams.getAll('status[]'), ['sample'])
  assert.equal(request.url.searchParams.has('status'), false)
  assert.equal(request.url.searchParams.get('include_archived'), '1')
})
