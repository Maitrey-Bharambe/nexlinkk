'use client';

import { AuthProvider } from '@/components/AuthProvider';
import Shell from '@/components/Shell';

export default function ConsoleLayout({ children }) {
  return (
    <AuthProvider>
      <Shell>{children}</Shell>
    </AuthProvider>
  );
}
