import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-grotesk', weight: ['400', '500', '600', '700'] });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', weight: ['400', '500'] });

export const metadata = {
  title: 'NexLink',
  description: 'Private networking, diagnostics and policy-gated remote ops',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
