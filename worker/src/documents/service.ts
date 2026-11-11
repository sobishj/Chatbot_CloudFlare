/** Documents (filled in with the documents stage). */

import type { Client } from "../models";
import type { StepContext } from "../worker/runner";

export interface SyncOptions {
  sources: string[];
  force: boolean;
  cursorKey?: string;
}

export async function syncDocumentsStep(
  _ctx: StepContext,
  _client: Client,
  _options: SyncOptions,
  _progress: (percent: number, text: string) => void,
): Promise<{ done: boolean; stats?: Record<string, number> }> {
  return { done: true, stats: { indexed: 0, unchanged: 0, removed: 0, errors: 0, chunks: 0 } };
}
