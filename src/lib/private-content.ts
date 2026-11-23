// The owner's private content, kept outside this shared repository: the Fusion research pages, the planned Fusion
// dashboards, the real Release 1 schedule and its PDF. ARCIUM_PRIVATE_DIR names the folder that holds them (the
// owner's copy lives in the private arcium_production_site repo, frontend_private/):
//
//   fusion/<module>/*.md            instead of content/fusion/
//   planned/<plan>.md               checked before content/planned/
//   schedule-release1.json          instead of src/lib/schedule-release1.json (a sample schedule here)
//   Arcium_10_Week_Schedule.pdf     the schedule PDF
//
// Without it (developers, CI, npm run sim) the site uses the public stand-ins in this repository.

import fs from 'node:fs';
import path from 'node:path';

const DIR = (process.env.ARCIUM_PRIVATE_DIR ?? '').trim();

/** The private copy of `rel` when ARCIUM_PRIVATE_DIR has it, otherwise `fallback`. */
export function privatePath(rel: string, fallback: string): string {
  if (DIR) {
    const p = path.resolve(/* turbopackIgnore: true */ DIR, rel);
    if (fs.existsSync(p)) return p;
  }
  return fallback;
}
