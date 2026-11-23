// Types for scripts/demo-seed.mjs, the demo seeder, so the simulated database (src/lib/sim-db.ts) can call it.
export const TEMPLATE_USER: string;
export function seedDemo(
  client: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  opts?: { seed?: number; systems?: number; label?: string },
): Promise<void>;
