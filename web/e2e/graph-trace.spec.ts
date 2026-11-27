import { expect, test } from '@playwright/test'
import { node, openFact, reveal, settled, start } from './helpers'

test('tracing a column draws its sources, and Esc puts the graph back', async ({ page }) => {
  await start(page)
  await openFact(page)
  const showColumns = page.getByRole('button', { name: 'Show columns', exact: true })
  await reveal(page, showColumns, 'Tools')
  await showColumns.click()
  const fact = node(page, 'gold.fact_order_lines')
  const column = fact.locator('.tbl-col', { hasText: 'net_amount' })
  await expect(column).toBeVisible()
  const before = await settled(page)

  await column.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Trace upstream' }).or(page.getByText('Trace upstream', { exact: true })).first().click()
  const bar = page.getByTestId('trace-bar')
  await expect(bar).toContainText('Tracing fact_order_lines.net_amount upstream')
  await expect(bar).toContainText('6 hops')
  await expect(node(page, 'bronze.raw_order_lines')).toBeVisible() // a table the trace needed, not on the graph before
  await expect(page.getByTestId('trace-details')).toContainText('bronze.raw_order_lines.qty')

  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(node(page, 'bronze.raw_order_lines')).toHaveCount(0)
  expect(await settled(page)).toEqual(before)
})
