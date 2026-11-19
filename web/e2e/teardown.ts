// Removes the temporary data folder the config made for the demo server.
import { rmSync } from 'node:fs'

export default function teardown() {
  const dir = process.env.E2E_DATA_DIR
  if (dir) rmSync(dir, { recursive: true, force: true })
}
