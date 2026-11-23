// Page (public): the Data Hub sign-in hand-off to the app (single sign-on).

import type { Metadata } from 'next';
import { APP_ORIGIN } from '@/lib/hosts';
import HubSignIn from './HubSignIn';

export const metadata: Metadata = { title: 'Data Hub sign-in' };

// datahub.arciumsignals.com/hub-signin: hands the browser to the Arcium sign-in on the app (single sign-on, client
// 'datahub') and takes the pass it brings back. See src/app/api/sso/accept and src/lib/sso.ts.
export default function HubSignInPage() {
  return <HubSignIn appOrigin={APP_ORIGIN} />;
}
