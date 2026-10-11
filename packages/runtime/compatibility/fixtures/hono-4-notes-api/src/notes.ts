import { randomUUID } from 'node:crypto';

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export function createNoteStore() {
  const notes = new Map<string, Note>();

  return {
    list: (): Note[] => [...notes.values()],
    get: (id: string): Note | undefined => notes.get(id),
    create(input: Pick<Note, 'title' | 'body'>): Note {
      const note: Note = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      notes.set(note.id, note);
      return note;
    },
    remove: (id: string): boolean => notes.delete(id)
  };
}
