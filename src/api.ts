/**
 * Lightweight HTTP client for the Xalantis API.
 * Used internally by the MCP server tools.
 */

const BASE_URL = 'https://xalantis.com/api/v1'
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
): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`)

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new ApiError(`Server returned non-JSON response (HTTP ${response.status})`, 'INVALID_RESPONSE', response.status)
  }

  if (!response.ok) {
    const err = json as { error?: { code?: string; message?: string; details?: Record<string, string[]> } }
    throw new ApiError(
      err?.error?.message || `Request failed (HTTP ${response.status})`,
      err?.error?.code || 'UNKNOWN_ERROR',
      response.status,
      err?.error?.details,
    )
  }

  return json
}
