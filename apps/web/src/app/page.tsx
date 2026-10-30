'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor, useAuth } from '@/lib/auth';

export default function Home() {
  const { status, me, teacherOnly } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status !== 'loading') router.replace(homeFor(me, teacherOnly));
  }, [status, me, teacherOnly, router]);
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status">
      <span className="font-display text-2xl font-bold text-primary">Ecole</span>
    </div>
  );
}
