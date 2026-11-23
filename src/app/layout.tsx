// No global CSS here: the portal loads Bootstrap + globals.css from its own
// layout, and the public pages use the scoped theme in app/_public.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Arcium Signals', template: '%s · Arcium Signals' },
  description: 'Arcium Signals: sign in to your portal',
  // The official Arcium Signals icon card (arcium_simulation/brand/cards).
  icons: { icon: '/arcium-signals-card-32.png', apple: '/arcium-signals-card-180.png' },
  // The picture and name a shared link shows (public/og-arcium-signals.png, 1200x630: the logo
  // centred so square crops keep it). SITE_URL makes its address absolute, as previews need.
  metadataBase: new URL(process.env.SITE_URL || 'https://app.arciumsignals.com'),
  openGraph: {
    type: 'website', siteName: 'Arcium Signals', title: 'Arcium Signals',
    description: 'One Arcium account for every Arcium dashboard.',
    images: [{ url: '/og-arcium-signals.png', width: 1200, height: 630, alt: 'Arcium Signals' }],
  },
  twitter: { card: 'summary_large_image', title: 'Arcium Signals', images: ['/og-arcium-signals.png'] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
