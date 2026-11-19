import { expect, test } from '@playwright/test'
import { picker, start } from './helpers'

test('the picker drills from a catalog to its objects and filters them by type', async ({ page }) => {
  await start(page)
  const list = picker(page)
  await list.getByText('demo_lake', { exact: true }).first().click()
  for (const schema of ['bronze', 'gold', 'silver']) await expect(list.getByText(schema, { exact: true })).toBeVisible()
  await list.getByText('silver', { exact: true }).first().click()
  await expect(list.getByText(/^10 objects/)).toBeVisible()
  await expect(list.getByText('customers', { exact: true })).toBeVisible()

  const views = list.getByRole('button', { name: 'Views', exact: true })
  await views.click()
  await expect(views).toHaveAttribute('aria-pressed', 'true')
  await expect(list.getByText('v_orders', { exact: true })).toBeVisible()
  await expect(list.getByText('v_orders_current', { exact: true })).toBeVisible()
  await expect(list.getByText('customers', { exact: true })).toHaveCount(0)

  await views.click()
  await expect(list.getByText('customers', { exact: true })).toBeVisible()
  await list.getByRole('button', { name: 'catalogs', exact: true }).click()
  await expect(list.getByText('samples', { exact: true })).toBeVisible()
})
