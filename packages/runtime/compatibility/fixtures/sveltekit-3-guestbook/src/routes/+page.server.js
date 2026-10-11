import { fail } from '@sveltejs/kit';

import { addEntry, listEntries } from '../lib/server/entries.js';

export function load() {
  return { entries: listEntries() };
}

export const actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    const name = String(data.get('name') ?? '').trim();
    const message = String(data.get('message') ?? '').trim();
    if (!name || !message) return fail(400, { error: 'Name and message are required' });
    addEntry(name, message);
    return { success: true };
  }
};
