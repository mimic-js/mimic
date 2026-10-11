import { data } from 'react-router';

import { findContact } from '../contacts.server';
import type { Route } from './+types/contact';

export function loader({ params }: Route.LoaderArgs) {
  const contact = findContact(params.id);
  if (!contact) throw data('Contact not found', { status: 404 });
  return { contact };
}

export default function Contact({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>{loaderData.contact.name}</h1>
      <p>{loaderData.contact.email}</p>
    </main>
  );
}
