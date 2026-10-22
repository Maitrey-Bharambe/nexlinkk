import { Space_Grotesk, JetBrains_Mono, Press_Start_2P } from 'next/font/google';
import './globals.css';

// Three faces, three jobs (see the type tokens in globals.css):
//   display   Press Start 2P — page titles, section titles, big numerals, identifiers
//   interface Space Grotesk  — everything people read: body, nav, buttons, forms, tables
//   mono      JetBrains Mono — technical values: IPs, ids, timestamps, measurements
const pixel = Press_Start_2P({ subsets: ['latin'], variable: '--font-pixel-face', weight: '400', display: 'swap' });
const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-grotesk', weight: ['400', '500', '600', '700'] });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', weight: ['400', '500'] });

export const metadata = {
  title: 'NexLink',
  description: 'Private networking, diagnostics and policy-gated remote ops',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${pixel.variable} ${grotesk.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
