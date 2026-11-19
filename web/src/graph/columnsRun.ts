// One column-level change over the graph's tables (keys on for all, or columns off for all), one table after another.

/** What one run does with the tables and how it learns it has been overtaken. */
export interface ColumnsJob {
  /** True: the keys level on every table, each loaded from the server. False: columns off for all. */
  show: boolean
  /** The tables to go through, read when the run starts (an earlier run may still be going until then). */
  ids: () => string[]
  /** Puts a table back to the plain level before its columns change. */
  reset: (id: string) => void
  /** Loads a table's columns and shows them. */
  load: (id: string) => Promise<void>
  /** Takes a table's columns off. */
  hide: (id: string) => void
  /** True once the run is no longer wanted (the lens it was for is gone): it ends at the next table, and takes off what it was loading. */
  stop?: () => boolean
}

let chain: Promise<void> = Promise.resolve()
let active = 0

/** Whether a run is going or waiting for the one before it. */
export const columnsBusy = () => active > 0

/** Runs a job after the ones before it, so a later change never meets a table an earlier run is still loading and then shows again. */
export async function runColumns(job: ColumnsJob): Promise<void> {
  const before = chain
  let release!: () => void
  chain = new Promise<void>((resolve) => (release = resolve))
  active++
  try {
    await before
    for (const id of job.ids()) {
      if (job.stop?.()) return
      job.reset(id)
      if (!job.show) {
        job.hide(id)
        continue
      }
      await job.load(id)
      if (job.stop?.()) {
        job.hide(id)
        return
      }
    }
  } finally {
    active--
    release()
  }
}
