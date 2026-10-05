/**
 * Lightweight HTTP client for the Xalantis API.
 * Used internally by the MCP server tools.
 */

import { randomUUID } from 'node:crypto'

const BASE_URL = resolveBaseUrl(process.env.XALANTIS_BASE_URL)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details?: Record<string, string[]>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Accepts an origin (https://app.example.com) or a full API base (…/api/v1). */
export function resolveBaseUrl(value: string | undefined): string {
  const base = (value?.trim() || 'https://xalantis.com/api/v1').replace(/\/+$/, '')
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`
}

/**
 * Query values: arrays are repeated (`status[]=a&status[]=b`), plain objects
 * become bracketed keys (`custom_fields[key]=value`), booleans become 1/0 —
 * Laravel's boolean rule rejects the strings "true" and "false".
 */
export function appendQuery(url: URL, params?: Record<string, unknown>): void {
  const scalar = (value: unknown) => (typeof value === 'boolean' ? (value ? '1' : '0') : String(value))

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      const name = key.endsWith('[]') ? key : `${key}[]`
      for (const item of value) url.searchParams.append(name, scalar(item))
    } else if (typeof value === 'object') {
      for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue !== undefined && subValue !== null) url.searchParams.append(`${key}[${sub}]`, scalar(subValue))
      }
    } else {
      url.searchParams.set(key, scalar(value))
    }
  }
}

/**
 * Every write carries an Idempotency-Key: about 80 routes reject writes without
 * one, and the others replay the first response when the same key comes back.
 * A fresh key per tool call never merges two distinct user actions.
 */
export function withIdempotencyKey(method: string, headers?: Record<string, string>): Record<string, string> {
  const out = { ...headers }
  const hasKey = Object.keys(out).some((name) => name.toLowerCase() === 'idempotency-key')
  if (method.toUpperCase() !== 'GET' && !hasKey) {
    out['Idempotency-Key'] = randomUUID()
  }
  return out
}

type ErrorBody = {
  message?: string
  code?: string
  error?: string | { code?: string; message?: string; details?: Record<string, string[]> }
  errors?: Record<string, string[]>
}

/**
 * The API answers errors in two shapes: `{ error: { code, message, details } }`
 * and, for idempotency or Laravel validation failures, a top-level
 * `{ message, code, errors }`.
 */
export function toApiError(json: unknown, status: number): ApiError {
  const body = (json ?? {}) as ErrorBody
  const nested = typeof body.error === 'object' ? body.error : undefined
  return new ApiError(
    nested?.message || body.message || `Request failed (HTTP ${status})`,
    nested?.code || body.code || (typeof body.error === 'string' ? body.error : 'UNKNOWN_ERROR'),
    status,
    nested?.details ?? body.errors,
  )
}

export function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID (got "${value}")`)
  }
}

export async function apiRequest(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`)
  appendQuery(url, params)

  const response = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...withIdempotencyKey(method, extraHeaders),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (response.status === 204) {
    return { success: true, data: null, message: null }
  }

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new ApiError(`Server returned non-JSON response (HTTP ${response.status})`, 'INVALID_RESPONSE', response.status)
  }

  if (!response.ok) {
    throw toApiError(json, response.status)
  }

  return json
}

export async function apiRawRequest(
  apiKey: string,
  method: string,
  path: string,
  body?: BodyInit,
  params?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Response> {
  const url = new URL(`${BASE_URL}${path}`)
  appendQuery(url, params)

  const response = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': headers?.Accept ?? 'application/json',
      ...withIdempotencyKey(method, headers),
    },
    body,
  })

  if (!response.ok) {
    let json: unknown
    try {
      json = await response.json()
    } catch {
      // Non-JSON download/upload errors keep the generic HTTP message.
    }

    throw toApiError(json, response.status)
  }

  return response
}
