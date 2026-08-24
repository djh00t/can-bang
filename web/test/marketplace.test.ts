import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarketplace, type MarketplaceItem } from '../src/marketplace.js'

const item: MarketplaceItem = {
  slug: 'agent-team-hq',
  title: 'Agent Team HQ',
  description: 'Coordinate a team of agents.',
  category: 'team',
  status: 'approved',
  scope: 'global',
}

test('renders a template marketplace page with safe item details and navigation', () => {
  const html = renderMarketplace('templates', [item])

  assert.match(html, /<h1>Templates<\/h1>/)
  assert.match(html, /Agent Team HQ/)
  assert.match(html, /Coordinate a team of agents\./)
  assert.match(html, /href="\/marketplace\/widgets"/)
  assert.match(html, /href="\/"[^>]*>Dashboard<\/a>/)
})

test('renders an empty widget marketplace with its browse heading', () => {
  const html = renderMarketplace('widgets', [])

  assert.match(html, /<h1>Widgets<\/h1>/)
  assert.match(html, /No approved widgets are available yet\./)
  assert.match(html, /href="\/marketplace\/templates"/)
})
