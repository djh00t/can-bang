export type MarketplaceKind = 'widgets' | 'templates'

export interface MarketplaceItem {
  slug: string
  title: string
  description?: string | null
  category?: string | null
  status?: string | null
  scope?: string | null
  builtin?: boolean
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  )
}

function itemLabel(kind: MarketplaceKind, item: MarketplaceItem): string {
  if (kind === 'widgets') return item.status || 'approved'
  if (item.builtin) return 'built-in'
  return item.scope || 'account'
}

function emptyMessage(kind: MarketplaceKind): string {
  return kind === 'widgets'
    ? 'No approved widgets are available yet.'
    : 'No templates are available yet.'
}

export function renderMarketplace(kind: MarketplaceKind, items: MarketplaceItem[]): string {
  const title = kind === 'widgets' ? 'Widgets' : 'Templates'
  const cards = items
    .map(
      (item) => `
        <article class="marketplace-card">
          <div class="marketplace-card-top">
            <span class="tag">${escapeHtml(item.category || 'general')}</span>
            <span class="muted small">${escapeHtml(itemLabel(kind, item))}</span>
          </div>
          <h2>${escapeHtml(item.title || item.slug)}</h2>
          <p class="muted">${escapeHtml(item.description || 'No description provided.')}</p>
          <code>${escapeHtml(item.slug)}</code>
        </article>`,
    )
    .join('')

  return `
    <div class="marketplace-shell">
      <header class="marketplace-head">
        <a class="btn-link" href="/">Dashboard</a>
        <div>
          <p class="marketplace-kicker">CanBang marketplace</p>
          <h1>${title}</h1>
          <p class="muted">Browse the reusable building blocks available to your agents and projects.</p>
        </div>
        <nav class="marketplace-tabs" aria-label="Marketplace sections">
          <a class="btn sm${kind === 'widgets' ? ' primary' : ''}" href="/marketplace/widgets">Widgets</a>
          <a class="btn sm${kind === 'templates' ? ' primary' : ''}" href="/marketplace/templates">Templates</a>
        </nav>
      </header>
      <main class="marketplace-grid">
        ${cards || `<div class="panel marketplace-empty"><p class="muted">${emptyMessage(kind)}</p></div>`}
      </main>
    </div>`
}

export async function mountMarketplace(root: HTMLElement, kind: MarketplaceKind): Promise<void> {
  root.innerHTML = '<div class="marketplace-shell"><p class="muted">Loading marketplace…</p></div>'
  try {
    const response = await fetch(`/api/${kind}`)
    if (!response.ok) throw new Error(`Request failed (${response.status})`)
    const body = (await response.json()) as { widgets?: MarketplaceItem[]; templates?: MarketplaceItem[] }
    const items = kind === 'widgets' ? body.widgets ?? [] : body.templates ?? []
    root.innerHTML = renderMarketplace(kind, items)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    root.innerHTML = `<div class="marketplace-shell"><a class="btn-link" href="/">Dashboard</a><div class="panel marketplace-error"><h1>Marketplace unavailable</h1><p class="muted">${escapeHtml(message)}</p></div></div>`
  }
}
