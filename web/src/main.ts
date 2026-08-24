import { mountWorkspace } from './workspace.js'
import { mountEditor } from './editor.js'

function route(): void {
  const app = document.getElementById('app')!
  const path = location.pathname
  const m = /^\/(?:d|pub)\/([A-Za-z0-9_-]+)/.exec(path)
  if (m) {
    const docId = m[1]!
    const key = new URLSearchParams(location.search).get('key') ?? ''
    const readonly = path.startsWith('/pub')
    void mountEditor(app, docId, key, readonly)
  } else {
    void mountWorkspace(app)
  }
}

route()
