import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mcpSource = readFileSync(new URL('../../mcp/src/index.ts', import.meta.url), 'utf8')
const cliSource = readFileSync(new URL('../../cli/src/index.ts', import.meta.url), 'utf8')

describe('project burndown protocol contract', () => {
  it('keeps the aggregate REST route reachable from MCP and CLI', () => {
    expect(mcpSource).toContain("'project_burndown'")
    expect(mcpSource).toContain('/api/projects/${encodeURIComponent(resolved.id!)}/burndown')
    expect(cliSource).toContain("verb === 'burndown'")
    expect(cliSource).toContain('/api/projects/${encodeURIComponent(project)}/burndown')
  })

  it('keeps the shared response fields in both protocol adapters', () => {
    expect(mcpSource).toContain('Read aggregate remaining work across all phases for a project.')
    expect(cliSource).toContain('points?: { date: string; remaining: number }[]')
    expect(cliSource).toContain('total?: number')
    expect(cliSource).toContain('current?: number')
  })
})
