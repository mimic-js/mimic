export interface Contact {
  id: string;
  name: string;
  email: string;
}

const contacts: Contact[] = [
  { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: 'alan', name: 'Alan Turing', email: 'alan@example.com' }
];

export function listContacts(): Contact[] {
  return contacts;
}

export function findContact(id: string): Contact | undefined {
  return contacts.find((contact) => contact.id === id);
}
