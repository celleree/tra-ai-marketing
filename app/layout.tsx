import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import '@/app/globals.css';
import '@/app/ui-sweep.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'TRA AI Marketing',
  description: 'Internal creative generation workspace for TRA marketing.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
