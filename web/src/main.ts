import { mountWorkspace } from './workspace.js'
import { mountEditor } from './editor.js'
import { mountMarketplace, type MarketplaceKind } from './marketplace.js'

function route(): void {
  const app = document.getElementById('app')!
  const path = location.pathname
  const m = /^\/(?:d|pub)\/([A-Za-z0-9_-]+)/.exec(path)
  if (m) {
    const docId = m[1]!
    const key = new URLSearchParams(location.search).get('key') ?? ''
    const readonly = path.startsWith('/pub')
    void mountEditor(app, docId, key, readonly)
  } else if (path === '/marketplace/widgets' || path === '/marketplace/templates') {
    const kind: MarketplaceKind = path.endsWith('/widgets') ? 'widgets' : 'templates'
    void mountMarketplace(app, kind)
  } else {
    void mountWorkspace(app)
  }
}

route()
