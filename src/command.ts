/**
 * Workbench → relay command path.
 * Token stays in localStorage only; never bake it into the build or repo.
 */

export const RELAY_BASE = 'https://bot-workbench-relay.alankris369.workers.dev'
export const RELAY_EVENTS_URL = `${RELAY_BASE}/events`
export const RELAY_COMMAND_URL = `${RELAY_BASE}/command`
export const RELAY_HEALTH_URL = `${RELAY_BASE}/health`

export const REPORT_TOKEN_KEY = 'workbench.reportToken'

export const COMMAND_TARGETS: { id: string; label: string }[] = [
  { id: 'lead', label: '总工程师' },
  { id: 'frontend', label: '前端开发' },
  { id: 'integration', label: '集成开发' },
  { id: 'qa', label: '测试员' },
]

export type CommandResult =
  | { ok: true; status: number; detail: string }
  | { ok: false; status: number; detail: string }

export function readReportToken(): string {
  try {
    return localStorage.getItem(REPORT_TOKEN_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function writeReportToken(token: string): void {
  const trimmed = token.trim()
  try {
    if (trimmed) localStorage.setItem(REPORT_TOKEN_KEY, trimmed)
    else localStorage.removeItem(REPORT_TOKEN_KEY)
  } catch {
    // Private mode can block storage; in-memory send still works for this session.
  }
}

export async function sendCommand(input: {
  to: string
  instruction: string
  token: string
  url?: string
}): Promise<CommandResult> {
  const to = input.to.trim()
  const instruction = input.instruction.trim()
  const token = input.token.trim()
  if (!to) return { ok: false, status: 0, detail: '请选择发给谁' }
  if (!instruction) return { ok: false, status: 0, detail: '请填写指令' }
  if (!token) return { ok: false, status: 0, detail: '请先填写上报令牌' }

  const url = input.url ?? RELAY_COMMAND_URL
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, instruction }),
    })
    let detail = `HTTP ${response.status}`
    try {
      const body: unknown = await response.json()
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>
        if (record.ok === true) detail = '已发出'
        else if (typeof record.error === 'string' && record.error.trim()) detail = record.error.trim()
        else if (typeof record.status === 'number') detail = `上游 HTTP ${record.status}`
      }
    } catch {
      // Keep status text when body is not JSON.
    }
    if (response.ok) return { ok: true, status: response.status, detail }
    return { ok: false, status: response.status, detail }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : '网络错误',
    }
  }
}
