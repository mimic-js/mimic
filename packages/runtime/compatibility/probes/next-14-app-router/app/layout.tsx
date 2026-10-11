import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Next app',
  description: 'A small App Router application'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
