export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

export function text(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

export function error(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

export function requireConfirmation(confirm: boolean | undefined, action: string): void {
  if (confirm !== true) {
    throw new Error(`Confirmation required before ${action}. Call this tool again with confirm=true after the user explicitly confirms.`)
  }
}
