import { Link } from 'react-router';

import { listContacts } from '../contacts.server';
import type { Route } from './+types/home';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Contacts' }];
}

export function loader() {
  return { contacts: listContacts() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>Contacts</h1>
      <ul>
        {loaderData.contacts.map((contact) => (
          <li key={contact.id}>
            <Link to={`/contacts/${contact.id}`}>{contact.name}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
