import { expect, test } from '@playwright/test'
import { lens, more, node, openFact, positions, settled, start, tables } from './helpers'

test('schema groups collapse to one node each and open again', async ({ page }) => {
  await start(page)
  await openFact(page)
  const gold = page.getByTestId('group-box-demo_lake.gold')
  const silver = page.getByTestId('group-box-demo_lake.silver')
  await expect(gold).toContainText('7 objects')
  await expect(silver).toContainText('2 objects')

  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(page.getByTestId('group-summary-demo_lake.gold')).toContainText('gold · 7 objects')
  await expect(page.getByTestId('group-summary-demo_lake.silver')).toContainText('silver · 2 objects')
  await expect(tables(page)).toHaveCount(0)

  await page.getByTestId('group-summary-demo_lake.silver').dblclick()
  await expect(silver).toBeVisible()
  await expect(node(page, 'silver.order_lines')).toBeVisible()
  await expect(tables(page)).toHaveCount(2)
  await expect(page.getByTestId('group-summary-demo_lake.gold')).toBeVisible()

  await page.getByRole('button', { name: 'Open all' }).click()
  await expect(page.getByTestId('group-summary-demo_lake.gold')).toHaveCount(0)
  await expect(tables(page)).toHaveCount(9)
})

test('a chain of views that only pass data on is one edge marked "via 2 views"', async ({ page }) => {
  await start(page)
  await openFact(page)
  await more(page, 'silver.v_orders_current', 'up').click({ modifiers: ['Shift'] })
  const pill = page.getByTestId('edge-merged')
  await expect(pill).toHaveText('via 2 views')
  await expect(pill).toHaveAttribute('title', /v_orders → demo_lake.silver.v_orders_current/)
  await expect(node(page, 'silver.v_orders_current')).toHaveCount(0)
  await expect(node(page, 'silver.v_orders')).toHaveCount(0)
  await expect(node(page, 'silver.orders')).toBeVisible()

  const chains = page.getByRole('button', { name: 'Chains', exact: true })
  await chains.click() // off: draw the views
  await expect(node(page, 'silver.v_orders_current')).toBeVisible()
  await expect(node(page, 'silver.v_orders')).toBeVisible()
  await expect(pill).toHaveCount(0)
  await chains.click()
  await expect(pill).toHaveText('via 2 views')
})

// Fails today: back in Flow, the saved positions come back and then a second layout moves every table (about 60 px
// across, a different spot on each run). Remove the fixme once the lens round trip leaves the tables alone.
test.fixme('Flow, Model and back to Flow puts every table where it was', async ({ page }) => {
  await start(page)
  await openFact(page)
  const all = await settled(page)
  await lens(page, 'Flow').click()
  await expect(lens(page, 'Flow')).toHaveAttribute('aria-pressed', 'true')
  await expect(tables(page)).toHaveCount(5) // the flow lens leaves the dimensions out
  // The first visit lays the lens out; wait for that, not for the positions the All lens left behind.
  await expect.poll(async () => (await positions(page))['gold.fact_order_lines']).not.toEqual(all['gold.fact_order_lines'])
  const flow = await settled(page)

  await lens(page, 'Model').click()
  await expect(tables(page)).toHaveCount(5) // the fact and its four dimensions
  await expect(node(page, 'gold.dim_date')).toBeVisible()
  const model = await settled(page)
  expect(model).not.toEqual(flow)

  await lens(page, 'Flow').click()
  await expect(node(page, 'silver.order_lines')).toBeVisible()
  expect(await settled(page)).toEqual(flow)

  await lens(page, 'All').click()
  await expect(tables(page)).toHaveCount(9)
  expect(await settled(page)).toEqual(all)
})

test('Color by schema fills the nodes by schema and the legend names them', async ({ page }) => {
  await start(page)
  await openFact(page)
  await page.getByLabel('Color by').selectOption({ label: 'Schema' })
  const fill = (short: string) => node(page, short).locator('.tbl-node').evaluate((e) => getComputedStyle(e).backgroundColor)
  await expect.poll(() => fill('gold.fact_order_lines')).not.toEqual(await fill('silver.order_lines'))
  expect(await fill('gold.dim_product')).toEqual(await fill('gold.fact_order_lines'))
  expect(await fill('silver.v_orders_current')).toEqual(await fill('silver.order_lines'))
  const legend = page.getByLabel('Color legend')
  await expect(legend).toContainText('demo_lake.gold')
  await expect(legend).toContainText('demo_lake.silver')
})
