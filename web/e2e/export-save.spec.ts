import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { lens, node, openFact, start, tables } from './helpers'

const FLOWCHART = [
  'flowchart LR',
  '  n1[["daily_revenue"]]',
  '  n2["fact_order_lines"]',
  '  n3["fact_returns"]',
  '  n4["order_lines"]',
  '  n5(["v_orders_current"])',
  '  n2 -->|"Σ"| n1',
  '  n2 --> n3',
  '  n4 --> n2',
  '  n5 --> n2',
].join('\n')

test('export gives Mermaid text and a PNG of the graph', async ({ page }) => {
  await start(page)
  await openFact(page)
  await lens(page, 'Flow').click()
  await expect(tables(page)).toHaveCount(5)
  await expect(page.getByTestId('edge-glyph-aggregate')).toBeVisible() // the transform label the text carries

  await page.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export the graph' })
  await expect(dialog).toContainText('Legend:')
  await dialog.getByRole('button', { name: 'Copy Mermaid flowchart' }).click()
  await expect(dialog.getByLabel('Mermaid text')).toHaveValue(FLOWCHART + '\n')

  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download PNG' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('Graph.png')
  const bytes = readFileSync(await file.path())
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect(bytes.length).toBeGreaterThan(2000)
})

test('a graph is saved, reloaded from the list, renamed and deleted', async ({ page }) => {
  await start(page)
  await openFact(page)
  await page.getByRole('button', { name: 'Save diagram', exact: true }).click()
  await page.getByRole('dialog', { name: 'Save diagram' }).getByRole('textbox').fill('e2e-roundtrip')
  await page.keyboard.press('Enter')
  const saved = page.getByLabel('Saved diagrams')
  await expect(saved.locator('option', { hasText: 'e2e-roundtrip' })).toHaveCount(1)

  await start(page) // a fresh page: the graph is gone until the saved one is loaded
  await expect(tables(page)).toHaveCount(0)
  await saved.selectOption('e2e-roundtrip')
  await page.getByRole('button', { name: 'Load', exact: true }).click()
  await expect(tables(page)).toHaveCount(9)
  await expect(node(page, 'gold.fact_order_lines')).toBeVisible()

  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename diagram' })
  await rename.getByRole('textbox').fill('e2e-renamed')
  await page.keyboard.press('Enter')
  await expect(saved.locator('option', { hasText: 'e2e-renamed' })).toHaveCount(1)
  await expect(saved.locator('option', { hasText: 'e2e-roundtrip' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete diagram' }).getByRole('button', { name: 'Delete' }).click()
  await expect(saved.locator('option', { hasText: 'e2e-renamed' })).toHaveCount(0)
})
