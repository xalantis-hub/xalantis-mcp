/**
 * Catalog of the public API v1 operations, read from the OpenAPI spec bundled
 * with the package (openapi/xalantis-openapi.json, refreshed by
 * scripts/sync-openapi.mjs). Backs the generic search/describe/call tools.
 */

import { readFileSync } from 'node:fs'

type JsonObject = Record<string, unknown>

export interface Param {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  type?: string
  description?: string
}

export interface FileField {
  name: string
  multiple: boolean
}

export interface Operation {
  id: string
  method: string
  path: string
  area: string
  summary: string
  description?: string
  scopes: string[]
  params: Param[]
  bodyType?: 'application/json' | 'multipart/form-data'
  bodyRequired: boolean
  bodySchema?: JsonObject
  fileFields: FileField[]
}

export interface OperationSummary {
  operation_id: string
  method: string
  path: string
  summary: string
  scopes: string[]
}

/** Search results are capped; `total` tells the model when it saw only part of them. */
export const MAX_SEARCH_RESULTS = 40
const MAX_REF_DEPTH = 3
const METHODS = ['get', 'post', 'put', 'patch', 'delete']

/** Lower-cases and strips diacritics so « tâche » matches « tache ». */
export function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").toLowerCase()
}

export class Catalog {
  readonly version: string
  private readonly ops: Operation[] = []
  private readonly byId = new Map<string, Operation>()
  private readonly schemas: JsonObject

  constructor(spec: JsonObject) {
    const info = (spec.info ?? {}) as JsonObject
    this.version = String(info.version ?? 'unknown')
    this.schemas = (((spec.components ?? {}) as JsonObject).schemas ?? {}) as JsonObject

    for (const [path, item] of Object.entries((spec.paths ?? {}) as Record<string, JsonObject>)) {
      for (const method of METHODS) {
        const raw = item[method] as JsonObject | undefined
        if (!raw) continue
        const op = parseOperation(method.toUpperCase(), path, raw)
        if (this.byId.has(op.id)) throw new Error(`Duplicate operationId in OpenAPI spec: ${op.id}`)
        this.ops.push(op)
        this.byId.set(op.id, op)
      }
    }
  }

  static load(): Catalog {
    const file = new URL('../openapi/xalantis-openapi.json', import.meta.url)
    return new Catalog(JSON.parse(readFileSync(file, 'utf8')) as JsonObject)
  }

  get size(): number {
    return this.ops.length
  }

  get(id: string): Operation | undefined {
    return this.byId.get(id)
  }

  /** Functional areas (OpenAPI tags) with their operation counts, in spec order. */
  areas(): Array<{ area: string; operations: number }> {
    const counts = new Map<string, number>()
    for (const op of this.ops) counts.set(op.area, (counts.get(op.area) ?? 0) + 1)
    return [...counts].map(([area, operations]) => ({ area, operations }))
  }

  /**
   * Every query word must appear in the operation id, path, summary or area.
   * Area and method filters are exact (accents ignored).
   */
  search(query = '', area?: string, method?: string): { operations: OperationSummary[]; total: number } {
    const words = fold(query).split(/\s+/).filter(Boolean)
    const wantedArea = area ? fold(area) : undefined
    const wantedMethod = method?.toUpperCase()
    const matches = this.ops.filter((op) => {
      if (wantedArea && fold(op.area) !== wantedArea) return false
      if (wantedMethod && op.method !== wantedMethod) return false
      const haystack = fold(`${op.id} ${op.path} ${op.summary} ${op.area}`)
      return words.every((word) => haystack.includes(word))
    })

    return {
      total: matches.length,
      operations: matches.slice(0, MAX_SEARCH_RESULTS).map((op) => ({
        operation_id: op.id,
        method: op.method,
        path: op.path,
        summary: op.summary,
        scopes: op.scopes,
      })),
    }
  }

  /** Parameters and body schema of one operation, with `$ref`s resolved a few levels deep. */
  describe(id: string): JsonObject {
    const op = this.byId.get(id)
    if (!op) throw new Error(`Unknown operation: ${id}. Use search_operations to find a valid operation_id.`)

    return {
      operation_id: op.id,
      method: op.method,
      path: op.path,
      area: op.area,
      summary: op.summary,
      description: op.description,
      scopes: op.scopes,
      parameters: op.params,
      body: op.bodyType
        ? {
            content_type: op.bodyType,
            required: op.bodyRequired,
            schema: this.resolve(op.bodySchema, 0),
            ...(op.fileFields.length ? { file_fields: op.fileFields } : {}),
          }
        : undefined,
    }
  }

  private resolve(value: unknown, depth: number): unknown {
    if (Array.isArray(value)) return value.map((item) => this.resolve(item, depth))
    if (!value || typeof value !== 'object') return value

    const obj = value as JsonObject
    const ref = typeof obj.$ref === 'string' ? obj.$ref.match(/^#\/components\/schemas\/(.+)$/) : null
    if (ref) {
      const target = this.schemas[ref[1]]
      return target && depth < MAX_REF_DEPTH ? this.resolve(target, depth + 1) : obj
    }

    return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, this.resolve(item, depth)]))
  }
}

function parseOperation(method: string, path: string, raw: JsonObject): Operation {
  const id = raw.operationId
  if (typeof id !== 'string' || !id) throw new Error(`Missing operationId for ${method} ${path}`)

  const scopes = ((raw.security ?? []) as Array<Record<string, string[]>>).flatMap((entry) => Object.values(entry).flat())
  const params = ((raw.parameters ?? []) as JsonObject[])
    .filter((p) => p.in === 'path' || p.in === 'query' || p.in === 'header')
    .map((p) => ({
      name: String(p.name),
      in: p.in as Param['in'],
      required: p.required === true,
      type: ((p.schema ?? {}) as JsonObject).type as string | undefined,
      description: p.description as string | undefined,
    }))

  const op: Operation = {
    id,
    method,
    path,
    area: ((raw.tags ?? []) as string[])[0] ?? 'Other',
    summary: String(raw.summary ?? ''),
    description: raw.description as string | undefined,
    scopes,
    params,
    bodyRequired: false,
    fileFields: [],
  }

  const body = raw.requestBody as JsonObject | undefined
  const content = (body?.content ?? {}) as Record<string, JsonObject>
  for (const type of ['application/json', 'multipart/form-data'] as const) {
    if (content[type]) {
      op.bodyType = type
      op.bodyRequired = body?.required === true
      op.bodySchema = content[type].schema as JsonObject | undefined
      break
    }
  }
  if (op.bodyType === 'multipart/form-data') op.fileFields = fileFields(op.bodySchema)

  return op
}

function fileFields(schema: JsonObject | undefined): FileField[] {
  const properties = (schema?.properties ?? {}) as Record<string, JsonObject>
  return Object.entries(properties)
    .flatMap(([name, prop]) => {
      if (prop.format === 'binary') return [{ name, multiple: false }]
      const items = (prop.items ?? {}) as JsonObject
      return prop.type === 'array' && items.format === 'binary' ? [{ name, multiple: true }] : []
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
