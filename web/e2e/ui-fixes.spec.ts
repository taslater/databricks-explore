// Regression scenarios from the UI audit: the picker toggle, Escape on dialogs, the Layout doctor and Concepts at 1280x720.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { start } from './helpers'

/** True when the element at the centre of the locator is the locator's own element (or inside it), so a click would land on it. */
async function clickable(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return top !== null && el.contains(top)
  })
}

const SIZES = [
  { width: 1500, height: 900 },
  { width: 1280, height: 720 },
]

for (const size of SIZES) {
  test(`the picker can be hidden and shown again on every tab at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await start(page)
    for (const tab of ['Canvas', 'Graph', 'Concepts', 'Ask']) {
      await page.getByRole('tab', { name: tab }).click()
      if (!(await page.getByRole('button', { name: 'Show picker' }).isVisible())) {
        await page.getByRole('button', { name: 'Hide picker' }).click()
      }
      const show = page.getByRole('button', { name: 'Show picker' })
      await expect(show).toBeVisible()
      expect(await clickable(show), `Show picker is covered on ${tab}`).toBe(true)
      await show.click()
      await expect(page.getByRole('button', { name: 'Hide picker' })).toBeVisible()
    }
  })
}

/** The distinct rows the Canvas strip's controls sit on, and whether the strip overflows sideways. */
async function stripRows(page: Page) {
  return page.locator('.canvas-bar').evaluate((bar) => {
    // One row of controls is about 25px tall plus the strip's padding; a second row adds 30 or more.
    return { oneRow: bar.clientHeight < 55, overflows: bar.scrollWidth > bar.clientWidth }
  })
}

test('the Canvas top strip is one row when it fits, and wraps without overflowing when it does not', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await start(page)
  await page.getByRole('tab', { name: 'Canvas' }).click()
  expect(await stripRows(page)).toEqual({ oneRow: true, overflows: false })
  await page.setViewportSize(SIZES[1])
  const narrow = await stripRows(page)
  expect(narrow.overflows).toBe(false)
})

test('Escape closes Agent access, Mine joins and Suggest from tags, and focus returns to the opener', async ({ page }) => {
  await start(page)
  const agent = page.getByRole('button', { name: 'Agent access' })
  await agent.click()
  await expect(page.getByRole('dialog', { name: 'Agent access' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(agent).toBeFocused()

  await page.getByRole('tab', { name: 'Graph' }).click()
  const mine = page.getByRole('button', { name: 'Mine joins…' })
  await mine.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: /Mine joins/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(mine).toBeFocused()

  await page.getByRole('tab', { name: 'Concepts' }).click()
  const suggest = page.getByRole('button', { name: /Suggest from tags/ })
  await suggest.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: /Suggest concepts/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(suggest).toBeFocused()
})

test('the Layout doctor does not cover the windows at 1280x720', async ({ page }) => {
  await page.setViewportSize(SIZES[1])
  await start(page)
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await page.getByRole('button', { name: '+ Query window' }).click()
  await page.getByRole('button', { name: 'Doctor' }).click()
  const panel = page.getByRole('region', { name: 'Layout doctor' })
  await expect(panel).toBeVisible()
  const win = page.locator('.react-flow__node-query')
  await expect(win).toBeVisible()
  expect(await clickable(win.getByRole('button', { name: 'Maximize window' }))).toBe(true)
  expect(await clickable(win.getByRole('button', { name: 'Delete window' }))).toBe(true)
  const p = (await panel.boundingBox())!
  const stage = (await page.locator('.canvas-stage').boundingBox())!
  expect(p.y + p.height).toBeLessThanOrEqual(stage.y + 1)
})

test('Find candidates is reachable on Concepts at 1280x720', async ({ page }) => {
  await page.setViewportSize(SIZES[1])
  await start(page)
  await page.getByRole('tab', { name: 'Concepts' }).click()
  await page.getByRole('button', { name: '+ New concept' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Sandbox environment')
  await page.getByLabel('Definition').fill('A concept with enough text to make the editor taller than a short window. '.repeat(6))
  await page.getByRole('button', { name: 'Create' }).click()
  const find = page.getByRole('button', { name: 'Find candidates' })
  await find.scrollIntoViewIfNeeded()
  await expect(find).toBeInViewport()
  expect(await clickable(find)).toBe(true)
})
