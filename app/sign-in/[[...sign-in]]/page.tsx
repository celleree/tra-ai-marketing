import { SignIn } from '@clerk/nextjs';
import { connection } from 'next/server';
import { isClerkConfigured } from '@/lib/auth/server-access';

export default async function SignInPage() {
  await connection();
  if (!isClerkConfigured()) return <main><h1>Sign-in is unavailable</h1><p>Authentication has not been configured for this environment.</p></main>;
  return <SignIn />;
}
