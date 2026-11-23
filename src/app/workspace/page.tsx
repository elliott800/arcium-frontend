// The old workspace address (the hubs and bookmarks link here).

import { redirect } from 'next/navigation';

export default function OldWorkspace() {
  redirect('/w');
}
