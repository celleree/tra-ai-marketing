import { SignIn } from '@clerk/nextjs';
import { connection } from 'next/server';
import { isClerkConfigured } from '@/lib/auth/server-access';
import { safeWorkspaceReturnPath } from '@/lib/auth/return-path';

const authPageStyle = {
  minHeight: '100dvh',
  display: 'grid',
  placeItems: 'center',
  padding: '24px',
} as const;

export default async function SignInPage({ searchParams }: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  await connection();
  if (!isClerkConfigured()) {
    return (
      <main style={authPageStyle}>
        <div>
          <h1>Sign-in is unavailable</h1>
          <p>Authentication has not been configured for this environment.</p>
        </div>
      </main>
    );
  }
  return (
    <main style={authPageStyle}>
      <SignIn forceRedirectUrl={safeWorkspaceReturnPath((await searchParams)?.redirect_url)} />
    </main>
  );
}
