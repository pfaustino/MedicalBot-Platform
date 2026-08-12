import { PRODUCT_DESCRIPTION_SHORT } from '@medbot/shared'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { BuildFooter } from './components/BuildFooter'
import { Nav } from './components/Nav'
import { Providers } from './components/Providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'MedicalBot',
  description: PRODUCT_DESCRIPTION_SHORT,
}

// Applies the saved theme before first paint so there is no flash of the wrong
// theme. No stored choice → the CSS falls back to the OS preference.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('medbot_theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Providers>
          <Nav />
          {children}
          <BuildFooter />
        </Providers>
      </body>
    </html>
  )
}
