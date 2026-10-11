const entries = [{ id: 1, name: 'Ada', message: 'First!' }];

export function listEntries() {
  return entries;
}

export function addEntry(name, message) {
  const entry = { id: entries.length + 1, name, message };
  entries.push(entry);
  return entry;
}
