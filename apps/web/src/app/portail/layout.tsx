import type { ReactNode } from 'react';
import { ParentShell } from '@/components/shell/parent-shell';

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <ParentShell>{children}</ParentShell>;
}
