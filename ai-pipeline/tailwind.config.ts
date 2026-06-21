import type { Config } from 'tailwindcss'

export default {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Material Design 3 Color System
        'primary': '#ffb4a2',
        'primary-container': '#ff562a',
        'on-primary': '#611200',
        'secondary': '#7cffa3',
        'secondary-container': '#00e779',
        'on-secondary': '#003919',
        'surface': '#12131a',
        'surface-container': '#1e1f27',
        'surface-container-low': '#1a1b23',
        'surface-container-high': '#292932',
        'surface-variant': '#33343d',
        'on-surface': '#e3e1ec',
        'on-surface-variant': '#e5beb4',
        'outline': '#ac8980',
        'error': '#ffb4ab',
        'error-container': '#93000a',
      },
      fontFamily: {
        'display': ['Syne', 'sans-serif'],
        'body': ['DM Sans', 'sans-serif'],
        'mono': ['JetBrains Mono', 'monospace'],
      },
      fontSize: {
        'display-lg': ['48px', { lineHeight: '56px', letterSpacing: '-0.02em', fontWeight: '800' }],
        'headline-lg': ['32px', { lineHeight: '40px', fontWeight: '700' }],
        'headline-md': ['24px', { lineHeight: '32px', fontWeight: '600' }],
        'body-lg': ['18px', { lineHeight: '28px', fontWeight: '400' }],
        'body-md': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'label-mono': ['14px', { lineHeight: '20px', letterSpacing: '0.05em', fontWeight: '500' }],
      },
      spacing: {
        'xs': '4px',
        'sm': '8px',
        'md': '16px',
        'lg': '24px',
        'xl': '40px',
      },
    },
  },
  plugins: [],
} satisfies Config