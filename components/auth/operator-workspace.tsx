import { UserButton } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';

export async function OperatorWorkspace({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await connection();
  const access = await getOperatorAccess();

  if (access.allowed) {
    return <><header className="studio-account"><UserButton /></header>{children}</>;
  }

  if (access.status === 401) redirect('/sign-in');

  if (access.status === 403) {
    return (
      <main>
        <header className="studio-account"><UserButton /></header>
        <h1>Operator access required</h1>
        <p>Your signed-in account is not approved for this workspace.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Authentication is unavailable</h1>
      <p>Please try again after this environment has been configured.</p>
    </main>
  );
}
