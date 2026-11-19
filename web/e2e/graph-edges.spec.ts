import { expect, test } from '@playwright/test'
import { lens, openFact, openObject, start } from './helpers'

test('edges come in families, and the legend lists what is on screen', async ({ page }) => {
  await start(page)
  await openFact(page)
  const legend = page.getByLabel('Legend', { exact: true })
  await expect(legend).toContainText('data flows')
  await expect(legend).toContainText('key reference')
  await expect(page.locator('.react-flow__edge-reference')).toHaveCount(4)
  await expect(page.locator('.react-flow__edge-flow')).toHaveCount(4)

  const references = page.getByRole('checkbox', { name: 'key reference' })
  await references.uncheck()
  await expect(page.locator('.react-flow__edge-reference')).toHaveCount(0)
  await expect(legend).not.toContainText('key reference')
  await expect(page.locator('.react-flow__edge-flow')).toHaveCount(4)
  await references.check()
  await expect(page.locator('.react-flow__edge-reference')).toHaveCount(4)
})

test('an edge that no longer holds is hidden until asked for, and the legend says so', async ({ page }) => {
  await start(page)
  await openObject(page, 'silver', 'v_orders_current')
  const stale = page.getByTestId('rf__edge-lineage:demo_lake.silver.orders<->demo_lake.silver.v_orders_current')
  await expect(page.getByTestId('rf__edge-view_dep:demo_lake.silver.v_orders->demo_lake.silver.v_orders_current')).toBeAttached()
  await expect(stale).toHaveCount(0)

  await page.getByText('More', { exact: true }).click()
  await page.getByRole('checkbox', { name: /superseded edges/ }).check()
  await expect(stale).toBeAttached()
  await expect(stale.locator('path.react-flow__edge-path')).toHaveCSS('stroke-dasharray', /\d/)
  await expect(page.getByLabel('Legend', { exact: true })).toContainText('no longer holds')
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
