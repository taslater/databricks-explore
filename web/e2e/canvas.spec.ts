import { expect, test } from '@playwright/test'
import { start } from './helpers'

test('a query window runs a statement and shows its rows', async ({ page }) => {
  await start(page)
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await page.getByRole('button', { name: '+ Query window' }).click()
  const window = page.locator('.react-flow__node-query')
  await window.locator('.cm-content').click()
  await page.keyboard.type('SELECT * FROM demo_lake.gold.dim_store LIMIT 3')
  await window.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(window).toContainText('SUCCEEDED')
  await expect(window).toContainText('3 rows')
  await expect(window.locator('.ag-header-cell', { hasText: 'store_id' })).toBeVisible()
  await expect(window.locator('.ag-row')).toHaveCount(3)
})
