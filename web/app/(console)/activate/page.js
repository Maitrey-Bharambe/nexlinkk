'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { Card, Loading, PageHeader } from '@/components/ui';
import { ApproveCode, UniversalCommand } from '@/features/devices/AddDevice';

/**
 * "Add a device": run one line on the computer, approve the code it shows.
 * The agent prints a link to this page with the code filled in.
 */
function Activate() {
  const params = useSearchParams();
  const { can } = useAuth();
  const code = params.get('code') || '';
  return (
    <div>
      <PageHeader
        kicker="no token to copy · nothing secret in the command"
        title={'add a\ndevice'}
        description="run the line on the computer you want to add. it shows a short code; enter it here, check it is the computer you expect, approve."
      >
        <Link href="/setup" className="font-mono text-[11px] uppercase tracking-wider text-mid hover:text-lime">guided setup →</Link>
      </PageHeader>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <Card label="1 · on the computer you are adding">
          <UniversalCommand />
        </Card>
        <Card label="2 · here: enter the code it shows">
          {can('devices:enroll') ? (
            <ApproveCode initialCode={code} />
          ) : (
            <p className="text-sm text-mid">your role can view devices but not add them. ask an operator to approve the code.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function ActivatePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Activate />
    </Suspense>
  );
}
