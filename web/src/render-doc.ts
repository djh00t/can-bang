import { renderMarkdown } from './markdown.js'

const payload = document.getElementById('payload')
const target = document.getElementById('doc')
if (payload && target) {
  const data = JSON.parse(payload.textContent ?? '{}') as { markdown?: string; title?: string }
  const title = document.getElementById('page-title')
  if (title && data.title) title.textContent = data.title
  target.innerHTML = renderMarkdown(data.markdown ?? '')
}
