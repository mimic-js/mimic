import { json } from '@sveltejs/kit';

import { listEntries } from '../../../lib/server/entries.js';

export function GET() {
  return json(listEntries());
}
