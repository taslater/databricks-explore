import { expect, test } from '@playwright/test'
import { lens, node, openFact, openObject, start } from './helpers'

test('edges come in families, each listed once with its swatch', async ({ page }) => {
  await start(page)
  await openFact(page)
  await expect(page.getByRole('checkbox', { name: 'data flows' })).toBeChecked()
  await expect(page.getByText('key reference', { exact: true })).toHaveCount(1)
  await expect(page.locator('.react-flow__edge-reference')).toHaveCount(4)
  await expect(page.locator('.react-flow__edge-flow')).toHaveCount(4)

  const references = page.getByRole('checkbox', { name: 'key reference' })
  await references.uncheck()
  await expect(page.locator('.react-flow__edge-reference')).toHaveCount(0)
  await expect(page.locator('.react-flow__edge-flow')).toHaveCount(4)
  await references.check()
  await expect(page.locator('.react-flow__edge-reference')).toHaveCount(4)
})

test('an edge that no longer holds is hidden until asked for', async ({ page }) => {
  await start(page)
  await openObject(page, 'silver', 'v_orders_current')
  const stale = page.getByTestId('rf__edge-lineage:demo_lake.silver.orders<->demo_lake.silver.v_orders_current')
  await expect(page.getByTestId('rf__edge-view_dep:demo_lake.silver.v_orders->demo_lake.silver.v_orders_current')).toBeAttached()
  await expect(stale).toHaveCount(0)

  await page.getByText('More', { exact: true }).click()
  await page.getByRole('checkbox', { name: /superseded edges/ }).check()
  await expect(stale).toBeAttached()
  await expect(stale.locator('path.react-flow__edge-path')).toHaveCSS('stroke-dasharray', /\d/)
})

test('the Model lens draws key references with crow\'s-foot ends and only the key columns', async ({ page }) => {
  await start(page)
  await openFact(page)
  await lens(page, 'Model').click()
  await expect(lens(page, 'Model')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Legend', { exact: true })).toContainText('ends:')

  // The fact references four dimensions: many at the fact's end, one (or zero or one) at theirs.
  const ends = page.locator('g[data-end]')
  await expect(ends.first()).toBeAttached()
  const kinds = new Set(await ends.evaluateAll((els) => els.map((e) => e.getAttribute('data-end'))))
  expect(kinds).toContain('zero_many')
  expect(kinds).toContain('one')

  const fact = page.locator('[data-id="demo_lake.gold.fact_order_lines"]')
  await expect(fact.locator('.tbl-key-pk')).toHaveCount(2)
  await expect(fact.locator('.tbl-key-fk').first()).toBeVisible()
  await expect(fact.locator('.tbl-col', { hasText: 'order_id' })).toBeVisible()
  await expect(fact.locator('.tbl-col', { hasText: 'quantity' })).toHaveCount(0)
  await fact.getByRole('button', { name: /more$/ }).click()
  await expect(fact.locator('.tbl-col', { hasText: 'quantity' })).toBeVisible()
  await fact.getByRole('button', { name: 'show keys only' }).click()
  await expect(fact.locator('.tbl-col', { hasText: 'quantity' })).toHaveCount(0)
})

test('the Graph panel is clearly headed sections, and its actions are reachable with a table selected at 1280x720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await start(page)
  await openFact(page)
  const panel = page.getByRole('complementary', { name: 'Details' })
  for (const h of ['Actions', 'Edges', 'Color by type', 'Groups']) await expect(panel.getByRole('heading', { name: h })).toBeVisible()
  // Each edge type is listed once, with its swatch, in the Edges list.
  await expect(panel.getByText('data flows', { exact: true })).toHaveCount(1)
  await expect(panel.getByText('key reference', { exact: true })).toHaveCount(1)
  await node(page, 'gold.fact_order_lines').locator('.tbl-node').click()
  const send = panel.getByRole('button', { name: 'Send to canvas' })
  await expect(send).toBeVisible()
  const box = (await send.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(720)
  // No Σ sits on a card, where it would cover the card's text.
  for (const glyph of await page.locator('.edge-glyph').all()) {
    const g = (await glyph.boundingBox())!
    for (const card of await page.locator('.react-flow__node-table .tbl-node').all()) {
      const c = (await card.boundingBox())!
      expect(g.x + g.width <= c.x || g.x >= c.x + c.width || g.y + g.height <= c.y || g.y >= c.y + c.height).toBe(true)
    }
  }
})
