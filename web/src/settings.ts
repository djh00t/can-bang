import { Api } from './api.js'
import { escapeHtml } from './markdown.js'

export interface SettingsToken {
  id: string
  label: string | null
  created_at?: number
  last_seen_at?: number | null
}

export interface SettingsTemplate {
  slug: string
  title: string
  description: string | null
  category: string | null
  builtin?: boolean
  scope?: string
}

export interface SettingsData {
  user: { username: string; agent_name: string | null }
  tokens: SettingsToken[]
  templates: SettingsTemplate[]
}

function tokenRow(token: SettingsToken): string {
  return `<li class="settings-token">
    <code>${escapeHtml(token.id)}</code>
    <span>${escapeHtml(token.label || 'Unlabelled token')}</span>
  </li>`
}

function templateCard(template: SettingsTemplate): string {
  return `<article class="settings-template">
    <div class="settings-template-meta">
      <span class="tag">${escapeHtml(template.category || 'general')}</span>
      <span class="muted small">${escapeHtml(template.builtin ? 'built-in' : template.scope || 'account')}</span>
    </div>
    <h3>${escapeHtml(template.title || template.slug)}</h3>
    <p class="muted">${escapeHtml(template.description || 'No description provided.')}</p>
  </article>`
}

export function renderSettings(data: SettingsData): string {
  const tokens = data.tokens.length
    ? `<ul class="settings-token-list" id="settings-token-list">${data.tokens.map(tokenRow).join('')}</ul>`
    : '<p class="muted" id="settings-token-list">No API tokens yet.</p>'
  const templates = data.templates.length
    ? `<div class="settings-template-grid">${data.templates.map(templateCard).join('')}</div>`
    : '<p class="muted">No account templates are available yet.</p>'

  return `<div class="settings-shell">
    <header class="settings-head">
      <a class="btn-link" href="/">Dashboard</a>
      <div>
        <p class="marketplace-kicker">CanBang account</p>
        <h1>Settings</h1>
        <p class="muted">Manage the identity, API access, and templates available to your agents.</p>
      </div>
    </header>
    <main class="settings-grid">
      <section class="panel settings-card">
        <div class="settings-card-head"><div><p class="marketplace-kicker">Identity</p><h2>Agent name</h2></div><span class="tag">Account</span></div>
        <p class="muted">Signed in as <b>${escapeHtml(data.user.username)}</b>. The agent name is used for token-authored activity.</p>
        <form id="settings-agent-form" class="settings-form">
          <label for="settings-agent-name">Agent name</label>
          <div class="settings-form-row">
            <input id="settings-agent-name" name="name" maxlength="60" value="${escapeHtml(data.user.agent_name || '')}" placeholder="e.g. builder" />
            <button class="btn primary" type="submit">Save name</button>
          </div>
          <span class="muted small" id="settings-agent-status" role="status"></span>
        </form>
      </section>
      <section class="panel settings-card">
        <div class="settings-card-head"><div><p class="marketplace-kicker">Access</p><h2>API tokens</h2></div><span class="tag">Secrets</span></div>
        <p class="muted">Existing tokens show only their safe identifier. New token secrets are shown once when minted.</p>
        <button class="btn primary" id="settings-create-token" type="button">Mint API token</button>
        <span class="muted small" id="settings-token-status" role="status"></span>
        <div class="settings-new-token" id="settings-new-token" hidden></div>
        ${tokens}
      </section>
      <section class="panel settings-card settings-templates-card">
        <div class="settings-card-head"><div><p class="marketplace-kicker">Reusable content</p><h2>Account templates</h2></div><a class="btn sm" href="/marketplace/templates">Browse marketplace</a></div>
        <p class="muted">Built-in and account-scoped templates ready for new documents.</p>
        ${templates}
      </section>
    </main>
  </div>`
}

function renderMessage(title: string, message: string): string {
  return `<div class="settings-shell"><header class="settings-head"><a class="btn-link" href="/">Dashboard</a><div><p class="marketplace-kicker">CanBang account</p><h1>${escapeHtml(title)}</h1></div></header><main class="panel settings-card"><p class="muted">${escapeHtml(message)}</p></main></div>`
}

export async function mountSettings(root: HTMLElement): Promise<void> {
  const api = new Api()
  root.innerHTML = '<div class="settings-shell"><p class="muted">Loading settings…</p></div>'
  try {
    const me = (await api.me())?.user
    if (!me) {
      root.innerHTML = renderMessage(
        'Sign in required',
        'Sign in from the dashboard to manage account settings.',
      )
      return
    }
    const [tokenData, templateData] = await Promise.all([api.tokens(), api.templates()])
    root.innerHTML = renderSettings({
      user: me,
      tokens: tokenData.tokens,
      templates: templateData.templates,
    })

    document.getElementById('settings-agent-form')?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const input = document.getElementById('settings-agent-name') as HTMLInputElement | null
      const status = document.getElementById('settings-agent-status')
      const name = input?.value.trim() ?? ''
      if (!name) {
        if (status) status.textContent = 'Enter an agent name.'
        return
      }
      try {
        await api.agentName(name)
        if (status) status.textContent = 'Agent name saved.'
      } catch (error) {
        if (status)
          status.textContent = error instanceof Error ? error.message : 'Unable to save name.'
      }
    })

    document.getElementById('settings-create-token')?.addEventListener('click', async () => {
      const button = document.getElementById('settings-create-token') as HTMLButtonElement | null
      const status = document.getElementById('settings-token-status')
      const output = document.getElementById('settings-new-token')
      if (button) button.disabled = true
      if (status) status.textContent = 'Minting token…'
      try {
        const created = await api.createToken()
        if (output) {
          output.hidden = false
          output.innerHTML = `<b>New token (shown once)</b><code>${escapeHtml(created.token)}</code>`
        }
        if (status) status.textContent = 'Store this token securely before leaving the page.'
      } catch (error) {
        if (status)
          status.textContent = error instanceof Error ? error.message : 'Unable to mint token.'
      } finally {
        if (button) button.disabled = false
      }
    })
  } catch (error) {
    root.innerHTML = renderMessage(
      'Settings unavailable',
      error instanceof Error ? error.message : 'Unable to load settings.',
    )
  }
}
