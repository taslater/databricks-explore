// Shared steps for the end-to-end scenarios: connect to the demo workspace, open objects, read the graph.
import { expect, type Locator, type Page } from '@playwright/test'

export const LAKE = 'demo_lake'

/** Loads the app and connects to the demo profile with its running warehouse (the server remembers a connection, so this always connects again). */
export async function start(page: Page) {
  // E2E_CPU_THROTTLE=4 runs the page on a CPU four times slower, like a busy CI runner.
  const rate = Number(process.env.E2E_CPU_THROTTLE ?? 1)
  if (rate > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate })
  // E2E_API_DELAY=400 holds every API answer back that many milliseconds, like a slow server.
  const delay = Number(process.env.E2E_API_DELAY ?? 0)
  if (delay > 0) await page.route('**/api/**', async (route) => (await new Promise((r) => setTimeout(r, delay)), route.continue()))
  await page.goto('/')
  await page.getByLabel('Profile').selectOption('demo')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected to demo')).toBeVisible()
  const warehouse = page.getByLabel('SQL warehouse')
  await warehouse.selectOption({ label: 'Demo Serverless (running)' })
  await expect(warehouse).not.toHaveValue('')
}

/** The picker panel. */
export const picker = (page: Page) => page.getByTestId('picker')

/** In Drill-down, from the top: demo_lake, a schema, and a click on the object, which opens it as a new graph. */
export async function openObject(page: Page, schema: string, name: string) {
  const list = picker(page)
  await list.getByRole('button', { name: 'catalogs', exact: true }).click()
  await list.getByText(LAKE, { exact: true }).first().click()
  await list.getByText(schema, { exact: true }).first().click()
  await list.getByText(name, { exact: true }).first().click()
}

/** The graph node of a demo_lake table, given as schema.table. */
export const node = (page: Page, shortName: string): Locator => page.locator(`[data-id="${LAKE}.${shortName}"]`)

/** Every table node on the graph (not the group boxes, and not the summary node of a collapsed group). */
export const tables = (page: Page) => page.locator('.react-flow__node-table:not([data-id^="summary:"])')

/** Opens gold.fact_order_lines, the fact the demo lakehouse is built around, and waits for its neighbors. */
export async function openFact(page: Page) {
  await openObject(page, 'gold', 'fact_order_lines')
  await expect(tables(page)).toHaveCount(9)
}

/** The flow position of each table node, by short name. */
export const positions = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll<HTMLElement>('.react-flow__node-table:not([data-id^="summary:"])')].map((e) => [e.dataset.id!.split('.').slice(1).join('.'), e.style.transform])),
  )

/** Waits until a layout has stopped moving the nodes, and returns where they ended up. */
export async function settled(page: Page): Promise<Record<string, string>> {
  let last = ''
  let still = 0
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await positions(page))
        still = now === last ? still + 1 : 0
        last = now
        return still
      },
      { intervals: [300], timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3)
  return JSON.parse(last)
}

/** The lens buttons. */
export const lens = (page: Page, name: 'Flow' | 'Model' | 'All') => page.getByRole('group', { name: 'Lens' }).getByRole('button', { name, exact: true })

/** The small count of neighbors not on the graph, at a node's left (up) or right (down). */
export const more = (page: Page, shortName: string, dir: 'up' | 'down') => node(page, shortName).locator(`.tbl-more-count.is-${dir}`)
