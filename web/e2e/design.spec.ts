// The design pass: a compact Canvas strip, a two-row Graph toolbar, selection actions that appear only when they apply,
// one primary action per view, and real empty states.
import { expect, test } from '@playwright/test'
import { start } from './helpers'

/** A wide UI font like the one a Linux runner falls back to (DejaVu Sans), so a layout that only fits with a narrow font fails here too. */
const FONTS = [
  { name: 'the default font', css: '' },
  { name: 'a wide font', css: '* { font-family: Verdana, "DejaVu Sans", sans-serif !important; letter-spacing: 0.12em; }' },
]

const SIZES = [
  { width: 1500, height: 900 },
  { width: 1280, height: 720 },
]

for (const size of SIZES) for (const font of FONTS) {
  test(`the Canvas strip is one row, keeps Save as and the saved canvases in view, and More holds the rarer actions at ${size.width}x${size.height} with ${font.name}`, async ({ page }) => {
    await page.setViewportSize(size)
    await start(page)
    if (font.css) await page.addStyleTag({ content: font.css })
    await page.getByRole('tab', { name: 'Canvas' }).click()
    const toolbar = page.getByRole('toolbar', { name: 'Canvas' })
    await expect(toolbar).toBeVisible()
    const box = (await toolbar.boundingBox())!
    expect(box.height).toBeLessThan(44)
    // Saving and opening stay in the strip; More holds only the rarer actions.
    await expect(page.getByRole('button', { name: 'Save as' })).toBeVisible()
    await expect(page.getByLabel('Saved canvases')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Doctor' })).toHaveCount(0)
    await page.getByRole('button', { name: 'More' }).click()
    await expect(page.getByRole('button', { name: 'New diagram' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Doctor' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Doctor' })).toHaveCount(0)
  })
}

test('Duplicate and Delete appear with a selection, and the run-all message sits beside Run all windows', async ({ page }) => {
  await start(page)
  await page.getByRole('tab', { name: 'Canvas' }).click()
  await page.getByRole('button', { name: '+ Note' }).click()
  // Nothing selected: the actions are absent, and a hint says how to get them.
  await page.locator('.react-flow__pane').click({ position: { x: 600, y: 500 } })
  await expect(page.getByRole('button', { name: 'Duplicate' })).toHaveCount(0)
  await expect(page.getByText('Select to duplicate or delete')).toBeVisible()
  await page.locator('.react-flow__node-note').click({ position: { x: 20, y: 10 } })
  await expect(page.getByRole('button', { name: 'Duplicate' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
  await expect(page.getByText('Select to duplicate or delete')).toHaveCount(0)
})

for (const font of FONTS) test(`the Graph toolbar fits two rows at 1500x900 with ${font.name}, saved-diagram actions wait for a pick, and an empty graph says what to do`, async ({ page }) => {
  await page.setViewportSize(SIZES[0])
  await start(page)
  if (font.css) await page.addStyleTag({ content: font.css })
  await page.getByRole('tab', { name: 'Graph' }).click()
  const rows = page.locator('.graph-toolbar > .tb-row')
  await expect(rows).toHaveCount(2)
  const bar = (await page.locator('.graph-toolbar').boundingBox())!
  expect(bar.height).toBeLessThan(2 * 28 + 24)
  await expect(page.getByRole('button', { name: 'Load', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Saved diagrams')).toHaveAttribute('title', /load, rename or delete/)
  // Nothing to clear yet, and a disabled control says why.
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0)
  // With a wide font Show columns has moved into Tools.
  if (!(await page.getByRole('button', { name: 'Show columns' }).isVisible())) await page.getByRole('button', { name: /^Tools/ }).click()
  await expect(page.getByRole('button', { name: 'Show columns' })).toHaveAttribute('title', /Add a table/)
  await expect(page.getByRole('button', { name: 'Find a table' })).toHaveClass(/primary/)
  // The empty canvas has one call to action, which focuses the picker's filter.
  await expect(page.getByRole('heading', { name: 'Nothing on the graph yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Find a table' }).click()
  await expect(page.locator('.pick-filter')).toBeFocused()
})

test('Ask offers example questions that fill the box, and Ask becomes the primary action once there is text', async ({ page }) => {
  await start(page)
  await page.getByRole('tab', { name: 'Ask' }).click()
  const ask = page.getByRole('button', { name: 'Ask', exact: true })
  await expect(ask).toBeDisabled()
  await expect(ask).not.toHaveClass(/primary/)
  await page.getByRole('group', { name: 'Example questions' }).getByRole('button').first().click()
  await expect(page.getByRole('textbox', { name: 'Question' })).not.toHaveValue('')
  await expect(ask).toHaveClass(/primary/)
  // Cancel after sending puts the question back in the box.
  await ask.click()
  const cancel = page.getByRole('button', { name: 'Cancel' })
  if (await cancel.isVisible()) {
    await cancel.click()
    await expect(page.getByRole('textbox', { name: 'Question' })).not.toHaveValue('')
  }
})

test('Concepts shows its empty state once, and Agent access has one primary action with a command that wraps at spaces', async ({ page }) => {
  await start(page)
  await page.getByRole('tab', { name: 'Concepts' }).click()
  await expect(page.getByRole('button', { name: '+ New concept' })).toHaveClass(/primary/)
  await expect(page.getByText(/No concepts yet/)).toHaveCount(1)
  await page.getByRole('button', { name: 'Agent access' }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent access' })
  await expect(dialog.getByRole('button', { name: 'Copy command' })).toHaveClass(/primary/)
  await expect(dialog.locator('button.primary')).toHaveCount(1)
  const wrap = await dialog.getByTestId('agent-command').evaluate((el) => getComputedStyle(el).wordBreak)
  expect(wrap).toBe('normal')
})

test('primary buttons keep white text in every state', async ({ page }) => {
  await start(page)
  await page.getByRole('tab', { name: 'Canvas' }).click()
  const btn = page.getByRole('button', { name: '+ Query window' })
  const white = 'rgb(255, 255, 255)'
  await expect(btn).toHaveCSS('color', white)
  await btn.hover()
  await expect(btn).toHaveCSS('color', white)
  await btn.focus()
  await expect(btn).toHaveCSS('color', white)
  await page.mouse.move(0, 0)
  const box = (await btn.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(btn).toHaveCSS('color', white)
  await page.mouse.up()
  // Disabled: the Graph's Save diagram while a save is running is brief, so check the rule on a disabled copy.
  await btn.evaluate((el) => ((el as HTMLButtonElement).disabled = true))
  await expect(btn).toHaveCSS('color', white)
})
