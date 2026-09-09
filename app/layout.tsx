import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
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
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  return (
    <html lang="en" className={inter.variable}>
      <body>{publishableKey ? <ClerkProvider publishableKey={publishableKey} signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/studio" signUpFallbackRedirectUrl="/studio" afterSignOutUrl="/sign-in">{children}</ClerkProvider> : children}</body>
    </html>
  );
}
