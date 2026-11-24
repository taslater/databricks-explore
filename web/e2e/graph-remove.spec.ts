import { expect, test } from '@playwright/test'
import { more, node, openFact, start, tables } from './helpers'

test('a selected table comes off the graph with the Remove button or the Delete key, and its neighbor count brings it back', async ({ page }) => {
  await start(page)
  await openFact(page)
  await expect(more(page, 'gold.fact_order_lines', 'up')).toHaveCount(0)

  // The button removes the table whose details are open.
  await node(page, 'silver.order_lines').click()
  await page.getByRole('button', { name: 'Remove from graph' }).click()
  await expect(node(page, 'silver.order_lines')).toHaveCount(0)
  await expect(tables(page)).toHaveCount(8)
  await expect(page.getByRole('button', { name: 'Remove from graph' })).toBeDisabled()

  // The fact now counts it as a neighbor that is not on the graph; a click adds it back.
  await expect(more(page, 'gold.fact_order_lines', 'up')).toHaveText('1')
  await more(page, 'gold.fact_order_lines', 'up').click()
  await expect(node(page, 'silver.order_lines')).toBeVisible()
  await expect(tables(page)).toHaveCount(9)

  // Delete removes every ticked table at once.
  await node(page, 'gold.dim_customer').click()
  await node(page, 'gold.dim_product').click({ modifiers: ['Shift'] })
  await expect(page.getByRole('button', { name: 'Remove 2 tables' })).toBeEnabled()
  await page.keyboard.press('Delete')
  await expect(node(page, 'gold.dim_customer')).toHaveCount(0)
  await expect(node(page, 'gold.dim_product')).toHaveCount(0)
  await expect(tables(page)).toHaveCount(7)

  // Clear takes everything off.
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(tables(page)).toHaveCount(0)
})
