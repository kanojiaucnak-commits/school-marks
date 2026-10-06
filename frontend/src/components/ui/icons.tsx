import type { ReactElement, ReactNode } from 'react';

/**
 * Inline SVG icon set.
 *
 * One family, one grid, one stroke weight. Bundling the paths beats an icon
 * package: no extra dependency, and Vite tree-shakes everything unreferenced.
 *
 * Rules that keep the set coherent:
 *  - everything is drawn on a 24×24 grid with a 1.75 stroke;
 *  - nothing here is decorative — if it does not label or clarify a control, it
 *    does not belong in the set;
 *  - all icons are `aria-hidden`. The accessible name always comes from text or
 *    an explicit `aria-label` on the control, never from the glyph.
 */

export interface IconProps {
  className?: string;
  /** Defaults to 1.125rem, which is the size the toolbar and table cells use. */
  size?: number | string;
  /** Solid fill variants look better at large sizes on a status badge. */
  strokeWidth?: number;
}

function Svg({ className, size = 18, strokeWidth = 1.75, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ==========================================================================
   Navigation
   ========================================================================== */

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </Svg>
);

export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Svg>
);

export const IconClipboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="3" width="8" height="4" rx="1" />
    <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
    <path d="M9 12h6M9 16h4" />
  </Svg>
);

export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5Z" />
    <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v4H6.5A2.5 2.5 0 0 1 4 19.5Z" />
  </Svg>
);

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Svg>
);

export const IconAward = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="9" r="6" />
    <path d="m8.2 14.3-1.7 7L12 18.5l5.5 2.8-1.7-7" />
  </Svg>
);

export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.5 4.5 5.5v6c0 5 3.2 8.9 7.5 10 4.3-1.1 7.5-5 7.5-10v-6Z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const IconCog = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .33 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.6 1.6 0 0 0 15 19.4a1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.09A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.33-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.09A1.6 1.6 0 0 0 15 4.6a1.6 1.6 0 0 0 1.77-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9c.14.6.68 1 1.27 1H21a2 2 0 1 1 0 4h-.09c-.6 0-1.11.4-1.51 1Z" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Svg>
);

/* ==========================================================================
   People
   ========================================================================== */

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
  </Svg>
);

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" />
    <circle cx="9.5" cy="7.5" r="3.5" />
    <path d="M21 20v-1.5a4 4 0 0 0-3-3.87" />
    <path d="M16 4.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconUserCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 20v-1.5a5 5 0 0 0-5-5H6a5 5 0 0 0-5 5V20" />
    <circle cx="8" cy="7" r="3.5" />
    <path d="m16 11 2 2 4-4" />
  </Svg>
);

export const IconGraduation = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 4 9 4.5-9 4.5-9-4.5Z" />
    <path d="M6.5 10.8V16c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3v-5.2" />
    <path d="M21 8.5V14" />
  </Svg>
);

/* ==========================================================================
   Workflow and status
   ========================================================================== */

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </Svg>
);

export const IconUnlock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 7.5-2" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.2 6.2A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.5-1.1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </Svg>
);

export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 10A9 9 0 1 1 3 13.5" />
    <path d="M3 4.5V10h5.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Svg>
);

export const IconListChecks = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 6 1.8 1.8L8 4.5" />
    <path d="m3 13 1.8 1.8L8 11.5" />
    <path d="M11 6.5h10M11 13.5h10" />
    <path d="M11 20h10" />
    <path d="m3 19.5 1.8 1.8L8 18" />
  </Svg>
);

export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h5l1.5 3h5L16 12h5" />
    <path d="M4.6 5.3 3 12v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5l-1.6-6.7A2 2 0 0 0 17.5 4h-11a2 2 0 0 0-1.9 1.3Z" />
  </Svg>
);

export const IconRotate = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </Svg>
);

/** Alias kept for call sites that read better as "refresh" than "rotate". */
export const IconRefresh = IconRotate;

export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 5h18l-7 8v6l-4-2v-4Z" />
  </Svg>
);

export const IconPercent = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 5 5 19" />
    <circle cx="7.5" cy="7.5" r="2.5" />
    <circle cx="16.5" cy="16.5" r="2.5" />
  </Svg>
);

export const IconTrending = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 16 5.5-5.5 3.5 3.5L21 5" />
    <path d="M15 5h6v6" />
  </Svg>
);

/* ==========================================================================
   Feedback
   ========================================================================== */

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 2 20h20Z" />
    <path d="M12 9.5v4.5M12 17.5v.01" />
  </Svg>
);

export const IconAlertCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V13M12 16.5v.01" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.5v.01" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconXCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 9 6 6M15 9l-6 6" />
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 8a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8" />
    <path d="M13.7 20a2 2 0 0 1-3.4 0" />
  </Svg>
);


/* ==========================================================================
   Files and data
   ========================================================================== */

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M12 4v12" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 11 5 5 5-5" />
    <path d="M12 16V4" />
  </Svg>
);

export const IconScan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" />
    <path d="M7 12h10" />
  </Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v5h5" />
  </Svg>
);

export const IconFileSearch = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6" />
    <path d="M14 2v5h5" />
    <circle cx="16.5" cy="16.5" r="3.5" />
    <path d="m19.5 19.5 2 2" />
  </Svg>
);

export const IconPrinter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 9V3h10v6" />
    <rect x="3" y="9" width="18" height="8" rx="2" />
    <path d="M7 17h10v4H7z" />
  </Svg>
);

export const IconTable = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9.5h18M3 15h18M9.5 9.5V20" />
  </Svg>
);

export const IconDatabase = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);

export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 8-8" />
    <path d="m17 6 2 2M14.5 8.5l2 2" />
  </Svg>
);

/* ==========================================================================
   Navigation affordances
   ========================================================================== */

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 9 7 7 7-7" />
  </Svg>
);

export const IconChevronsUpDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h16M14 6l6 6-6 6" />
  </Svg>
);

export const IconCornerDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4v7a3 3 0 0 0 3 3h13" />
    <path d="m15 10 4 4-4 4" />
  </Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Svg>
);

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="16" cy="18" r="2" />
  </Svg>
);

export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.2" />
  </Svg>
);

export const IconHash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 9h14M5 15h14M10 3.5 8.5 20.5M15.5 3.5 14 20.5" />
  </Svg>
);

/* ==========================================================================
   Registry
   ========================================================================== */

/**
 * Name -> component, used by the sidebar navigation and any data-driven icon
 * lookup, so an unknown key degrades to a neutral glyph rather than throwing.
 */
export const ICONS: Record<string, (props: IconProps) => ReactElement> = {
  home: IconHome,
  edit: IconEdit,
  check: IconCheckCircle,
  scan: IconScan,
  users: IconUsers,
  user: IconUser,
  upload: IconUpload,
  download: IconDownload,
  calendar: IconCalendar,
  grid: IconGrid,
  book: IconBook,
  clipboard: IconClipboard,
  link: IconLink,
  award: IconAward,
  chart: IconChart,
  shield: IconShield,
  cog: IconCog,
};
