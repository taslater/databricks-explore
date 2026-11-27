// Themes: a header toggle (system, light, dark) that is remembered and applied before first paint, and dark surfaces on Canvas and Graph.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openFact, start } from './helpers'

const THEME = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)

/** Relative luminance (0 black, 1 white) of the background an element is drawn with. */
async function luminance(el: Locator): Promise<number> {
  return el.evaluate((e) => {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(e).backgroundColor)
    const [r, g, b] = (m ? m[1].split(/[\s,/]+/).filter(Boolean).map(Number) : [255, 255, 255]).slice(0, 3).map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  })
}

test('the theme toggle follows the system by default, and a choice survives a reload with no flash', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  expect(await THEME(page)).toBe('light')
  const group = page.getByRole('group', { name: 'Theme' })
  await expect(group.getByRole('button', { name: 'System theme' })).toHaveAttribute('aria-pressed', 'true')

  await group.getByRole('button', { name: 'Dark theme' }).click()
  expect(await THEME(page)).toBe('dark')
  expect(await page.evaluate(() => localStorage.getItem('explore.theme'))).toBe('dark')

  // Applied by the script in index.html, before the app has rendered anything: the attribute is there at DOMContentLoaded.
  await page.reload({ waitUntil: 'domcontentloaded' })
  expect(await THEME(page)).toBe('dark')
  await expect(page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true')
  expect(await luminance(page.locator('body'))).toBeLessThan(0.2)

  // Back to the system: the stored choice goes, and the page follows the browser, live.
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System theme' }).click()
  expect(await page.evaluate(() => localStorage.getItem('explore.theme'))).toBeNull()
  expect(await THEME(page)).toBe('light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => THEME(page)).toBe('dark')
})

test('in dark mode the Canvas has a recessed canvas, tinted panels and raised windows', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await start(page)
  expect(await THEME(page)).toBe('dark')
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await page.getByRole('button', { name: '+ Query window' }).click()
  const win = page.locator('.react-flow__node-query .qw-node')
  await expect(win).toBeVisible()
  const [shell, panel, canvas, card] = await Promise.all([
    luminance(page.locator('header.topbar')),
    luminance(page.getByRole('complementary', { name: 'Picker' })),
    luminance(page.getByRole('main')),
    luminance(win),
  ])
  for (const l of [shell, panel, canvas, card]) expect(l).toBeLessThan(0.1)
  // Layers: the canvas is the deepest, the window is the raised one.
  expect(canvas).toBeLessThan(panel)
  expect(card).toBeGreaterThan(canvas)
  expect(card).toBeGreaterThan(panel)
  // The editor is themed too: dark, with readable text.
  expect(await luminance(page.locator('.cm-editor').first())).toBeLessThan(0.1)
  expect(await page.locator('.cm-content').first().evaluate((e) => getComputedStyle(e).color)).not.toBe('rgb(0, 0, 0)')
})

test('in dark mode the Graph draws dark cards on a dark canvas', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await start(page)
  await page.getByRole('tab', { name: 'Graph' }).click()
  await openFact(page)
  const card = page.locator('.react-flow__node-table .tbl-node').first()
  await expect(card).toBeVisible()
  expect(await luminance(card)).toBeLessThan(0.15)
  expect(await luminance(page.locator('.react-flow').first())).toBeLessThan(0.05)
  await expect(page.locator('.react-flow.dark')).toHaveCount(1)
  // Switching to light repaints the same cards.
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light theme' }).click()
  expect(await luminance(card)).toBeGreaterThan(0.5)
})
