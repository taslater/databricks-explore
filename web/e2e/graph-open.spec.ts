import { expect, test } from '@playwright/test'
import { more, node, openFact, openObject, start, tables } from './helpers'

test('opening a table draws its neighbors, with counts that add one hop or follow the chain', async ({ page }) => {
  await start(page)
  await openFact(page)
  for (const t of ['gold.dim_customer', 'gold.dim_product', 'silver.order_lines']) await expect(node(page, t)).toBeVisible()
  await expect(more(page, 'gold.dim_customer', 'up')).toHaveText('1')

  // A click adds one hop: the silver table, not what feeds it.
  await more(page, 'gold.dim_product', 'up').click()
  await expect(node(page, 'silver.products')).toBeVisible()
  await expect(node(page, 'bronze.raw_products')).toHaveCount(0)
  await expect(tables(page)).toHaveCount(10)

  // Shift-click follows the chain to its end.
  await more(page, 'gold.dim_customer', 'up').click({ modifiers: ['Shift'] })
  await expect(node(page, 'silver.customers')).toBeVisible()
  await expect(node(page, 'bronze.raw_customers')).toBeVisible()
  await expect(tables(page)).toHaveCount(12)
  await expect(more(page, 'gold.dim_customer', 'up')).toHaveCount(0)
})

test('a dropped table that lineage still names is drawn as missing, with the reason', async ({ page }) => {
  await start(page)
  await openObject(page, 'silver', 'sessions')
  const gone = node(page, 'silver.sessions_v1')
  await expect(gone).toBeVisible()
  await expect(gone.locator('.tbl-node')).toHaveClass(/is-missing/)
  await expect(gone.locator('.tbl-node')).toHaveAttribute('title', 'Does not exist: table `demo_lake.silver.sessions_v1` does not exist')
  await expect(node(page, 'silver.sessions')).toBeVisible()
})
