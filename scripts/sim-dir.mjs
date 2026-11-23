// Where `npm run sim` keeps its simulated database (and the mock machine its state): .sim-db/ in the repository, or
// ARCIUM_SIM_DIR (from the environment or .env.local). Set ARCIUM_SIM_DIR when the repository sits in a synced
// folder (Google Drive, OneDrive, Dropbox): their clients hard-link or lock files while uploading them, and the
// database then cannot reopen its own files ("PGlite failed to initialize properly").
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function simDir() {
  let dir = process.env.ARCIUM_SIM_DIR?.trim();
  if (!dir && existsSync('.env.local')) {
    dir = (readFileSync('.env.local', 'utf8').match(/^ARCIUM_SIM_DIR=(.*)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  }
  return path.resolve(dir || '.sim-db');
}
