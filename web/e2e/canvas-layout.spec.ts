// The Canvas keeps its floating controls clear of the windows: a maximized window can be restored, and nothing covers a button.
import { expect, test, type Locator } from '@playwright/test'
import { start } from './helpers'

/** True when the element at the centre of the locator is the locator's own element (or inside it), so a click would land on it. */
async function clickable(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return top !== null && el.contains(top)
  })
}

async function openCanvas(page: Parameters<typeof start>[0]) {
  await start(page)
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await page.getByRole('button', { name: '+ Query window' }).click()
}

test('a maximized window can always be restored, by its own button or Escape', async ({ page }) => {
  await openCanvas(page)
  const win = page.locator('.react-flow__node-query')
  const before = await win.boundingBox()
  await page.getByRole('button', { name: 'Maximize window' }).click()

  const restore = win.getByRole('button', { name: 'Restore window size' })
  await expect(restore).toBeVisible()
  expect(await clickable(restore)).toBe(true)
  expect(await clickable(win.getByRole('button', { name: 'Delete window' }))).toBe(true)
  // The palette sits beside the maximized window, not over its Results tab.
  const palette = (await page.locator('.sk-palette').boundingBox())!
  const maxed = (await win.boundingBox())!
  expect(maxed.x).toBeGreaterThanOrEqual(palette.x + palette.width)
  expect(await clickable(win.getByRole('tab', { name: 'Results' }).or(win.getByText('Results', { exact: true }).first()))).toBe(true)

  await restore.click()
  await expect(win.getByRole('button', { name: 'Maximize window' })).toBeVisible()
  const after = (await win.boundingBox())!
  expect(Math.round(after.width)).toBe(Math.round(before!.width))

  await page.getByRole('button', { name: 'Maximize window' }).click()
  await expect(win.getByRole('button', { name: 'Restore window size' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(win.getByRole('button', { name: 'Maximize window' })).toBeVisible()
})

test('a second window opens in view beside the first, not on top of it', async ({ page }) => {
  await openCanvas(page)
  await page.getByRole('button', { name: '+ Query window' }).click()
  const windows = page.locator('.react-flow__node-query')
  await expect(windows).toHaveCount(2)
  const stage = (await page.locator('.canvas-stage').boundingBox())!
  const [a, b] = [(await windows.nth(0).boundingBox())!, (await windows.nth(1).boundingBox())!]
  const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
  expect(apart).toBe(true)
  for (const box of [a, b]) {
    expect(box.x).toBeGreaterThanOrEqual(stage.x)
    expect(box.y).toBeGreaterThanOrEqual(stage.y)
    expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width)
    expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)
  }
})

test('at a narrow width with Properties open, nothing covers the buttons or the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await start(page)
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await page.getByRole('button', { name: 'Hide picker' }).click()
  await page.getByRole('button', { name: 'Properties' }).click()
  for (const name of ['+ Query window', '+ Note', 'Minimap', 'Save']) {
    expect(await clickable(page.getByRole('button', { name, exact: true })), name).toBe(true)
  }
  await page.getByRole('button', { name: '+ Query window' }).click()
  const stage = (await page.locator('.canvas-stage').boundingBox())!
  const bar = (await page.locator('.sk-editbar').boundingBox())!
  // The edit bar is below the canvas, not over the window.
  expect(bar.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1)
  const win = page.locator('.react-flow__node-query')
  for (const name of ['Maximize window', 'Delete window']) {
    const button = win.getByRole('button', { name })
    expect(await clickable(button), name).toBe(true)
    const box = (await button.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width)
  }
})
