/** @type {import('tailwindcss').Config} */

/**
 * Design tokens.
 *
 * This is school administration software, not a landing page. The scale is built
 * for long sessions in front of a marks grid, so:
 *
 *  - the page background is a warm parchment rather than cold grey, which reads
 *    as "school stationery" and, more practically, reduces the glare of a large
 *    pale area in a bright classroom where a projector or a sunny window is on;
 *  - exactly one accent — the school's own institutional slate-teal — plus a
 *    sage secondary lifted from the same palette. Everything else is a semantic
 *    status colour, used only to communicate state;
 *  - radius is deliberately small. `rounded-2xl` on everything is the clearest
 *    tell of a generated dashboard, and rounded rectangles on a dense table
 *    waste the pixels a scanner needs;
 *  - shadows are for things that genuinely float — menus, dialogs, toasts — and
 *    nowhere else.
 *
 * The accent is `hsl(199 25% 35%)` = `#43616f`, the colour the school already
 * uses on its own letterhead and website, so the software and the printed
 * mark sheet look like they came from the same institution.
 *
 * The palette is *extended*, not replaced, so `slate-*` picks up the new warm
 * neutral ramp while the legacy `rose-*` / `emerald-*` names keep resolving
 * during the migration to the semantic scales below.
 */

/**
 * Warm neutral ramp.
 *
 * Same lightness ladder as before so contrast ratios are unchanged, but rotated
 * off blue towards paper: the blue in the old ramp made white table surfaces
 * read as clinical, and the whole app felt like a SaaS console rather than a
 * school's record book.
 */
const slate = {
  0: '#ffffff',
  25: '#fdfcfa',
  50: '#faf8f4',
  100: '#f3efe7',
  150: '#e9e3d8',
  200: '#dcd4c5',
  300: '#c2b8a5',
  400: '#9a8f79',
  500: '#6f6655',
  600: '#57503f',
  700: '#443e31',
  800: '#2e2a21',
  850: '#221f18',
  900: '#1a1813',
  950: '#0f0e0a',
};

/**
 * Builds a semantic ramp from three tones rather than ten.
 *
 * The full 50–950 ladder is only useful if a designer can pick freely; for a
 * status colour there is exactly one correct background, one text colour and one
 * border. Keeping the ramp short removes the chance of picking `danger-200` by
 * accident and ending up with an unreadable badge.
 */
const semantic = (soft, base, strong) => ({
  soft,
  base,
  strong,
  // Convenience aliases so `text-success` and `bg-success-soft` both work.
  DEFAULT: base,
  50: soft,
  100: soft,
  200: base,
  300: base,
  400: base,
  500: base,
  600: base,
  700: strong,
  800: strong,
  900: strong,
});

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /** Neutral ramp. Overrides Tailwind's default `slate`. */
        slate,
        gray: slate,

        /** Neutral surfaces. `app` is the page, `surface` is data, `sunken` is a well. */
        app: {
          DEFAULT: slate[50],
          raised: slate[25],
        },
        surface: {
          DEFAULT: '#ffffff',
          muted: slate[50],
          sunken: slate[100],
        },
        canvas: {
          DEFAULT: slate[50],
          sunken: slate[100],
          inverse: slate[900],
        },

        /**
         * The one accent: the school's institutional slate-teal, `#43616f`.
         * Reserved for interactive affordances and the active navigation state,
         * never for decoration. Desaturated on purpose — a saturated blue at
         * this density reads as a consumer app.
         */
        brand: {
          50: '#f2f6f7',
          100: '#e4edef',
          200: '#c8dade',
          300: '#a3bfc7',
          400: '#789cab',
          500: '#577f8d',
          600: '#43616f',
          700: '#344e59',
          800: '#2a3f48',
          900: '#203038',
          950: '#121e24',
        },

        /**
         * The school's secondary, `#5d7772`. Used for *identity* rather than
         * state — a masthead rule, the crest field, the print letterhead — so the
         * software carries the school's second colour without a second accent
         * competing with `brand` for the user's attention.
         */
        sage: {
          50: '#f3f6f5',
          100: '#e5ecea',
          200: '#cad8d4',
          300: '#a5bbb5',
          400: '#7d9a93',
          500: '#5d7772',
          600: '#4c6360',
          700: '#3e504d',
          800: '#33413f',
          900: '#2b3634',
          950: '#161d1c',
        },

        /* Status palette. Always paired with a text label, never colour alone. */
        success: semantic('#eefaf3', '#229a68', '#136346'),
        warning: semantic('#fdf7ec', '#c57718', '#804116'),
        danger: semantic('#fdf2f3', '#d94a58', '#a02432'),
        info: semantic('#eff6fb', '#3a82bb', '#27557f'),
        /** Locked / immutable. Deliberately distinct from "approved". */
        sealed: semantic('#f4f2fb', '#7460b2', '#4f417a'),
        /** Neutral status: draft, queued, inactive. */
        muted: semantic('#f3efe7', '#9a8f79', '#57503f'),

        /** Borders, so every rule in the app lands on the same value. */
        line: {
          DEFAULT: slate[200],
          soft: slate[150],
          strong: slate[300],
          inverted: slate[700],
        },

        /** Text tones. */
        ink: {
          DEFAULT: slate[900],
          muted: slate[600],
          subtle: slate[500],
          faint: slate[400],
          inverted: '#ffffff',
        },
      },

      fontFamily: {
        /**
         * UI text. A system stack, deliberately: this app is used on modest
         * hardware over school networks, and a webfont on every data cell is a
         * real cost for no legibility gain at 13px. The display face below is
         * where the character comes from.
         */
        sans: [
          'Inter',
          'Inter var',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        /**
         * Headings and the school wordmark only.
         *
         * Lato is the face the school already sets its name in, so the app and
         * the website share a voice. Loading one family rather than the two the
         * website loads keeps the critical payload small, and `font-display:
         * swap` means a blocked font request degrades to the UI stack instead of
         * leaving the page invisible.
         */
        display: ['Lato', 'Inter', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },

      /* A compact type scale. `2xl` is the largest a page title ever gets. */
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.5rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
      },

      borderRadius: {
        xs: '2px',
        sm: '3px',
        DEFAULT: '4px',
        md: '5px',
        lg: '6px',
        xl: '8px',
        '2xl': '10px',
        '3xl': '14px',
      },

      /* Shadows only where something genuinely floats. */
      boxShadow: {
        xs: '0 1px 1px 0 rgb(28 25 19 / 0.05)',
        card: '0 1px 2px -1px rgb(28 25 19 / 0.08), 0 1px 3px -1px rgb(28 25 19 / 0.04)',
        popover: '0 8px 24px -6px rgb(28 25 19 / 0.16), 0 2px 6px -2px rgb(28 25 19 / 0.06)',
        dialog: '0 24px 48px -12px rgb(28 25 19 / 0.26)',
      },

      /* One control-height scale, so a toolbar of mixed inputs lines up. */
      height: {
        control: { xs: '1.75rem', sm: '2rem', DEFAULT: '2.375rem', md: '2.75rem' },
      },

      maxWidth: {
        prose: '68ch',
        sheet: '90rem',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(-4px) scale(0.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-out-right': {
          from: { opacity: '1', transform: 'translateX(0)' },
          to: { opacity: '0', transform: 'translateX(16px)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        /* Used sparingly, and only to say "this value just changed". */
        'value-pulse': {
          '0%': { backgroundColor: 'rgb(197 119 24 / 0.2)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },

      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'pop-in': 'pop-in 130ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-right': 'slide-in-right 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-out-right': 'slide-out-right 140ms ease-in forwards',
        'value-pulse': 'value-pulse 700ms ease-out',
      },

      transitionDuration: {
        100: '100ms',
        150: '150ms',
        200: '200ms',
      },
    },
  },
  plugins: [],
};