/**
 * School identity.
 *
 * Everything the application says about *who it belongs to* resolves from here,
 * so rebranding the software for another school is an edit to this one file
 * rather than a search across twenty components.
 *
 * Values are overridable at build time. The defaults describe the school this
 * system was built for; a deployment for a different institution sets the
 * `VITE_SCHOOL_*` variables in `.env.local` and changes nothing else.
 *
 * Nothing here is security-relevant. It is branding, and it is rendered as text,
 * never trusted as markup.
 */

/**
 * Reads an override, falling back to the built-in default.
 *
 * The return type is `string` even for the fields the interface marks optional,
 * because every default is populated — an empty string simply means "not
 * configured", and the call sites already treat these as optional by testing for
 * truthiness. Typing the result as `string | undefined` would push a `?.` onto
 * every render site for no benefit.
 */
function setting(key: string, fallback: string): string {
  const value = import.meta.env[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export interface SchoolIdentity {
  /** Full legal name, used on the print letterhead and the sign-in header. */
  name: string;
  /** Short form for the collapsed sidebar. */
  shortName: string;
  /** Location line — address as it appears on the school's own documents. */
  location: string;
  /** Governing body. Appears in the footer and on the printed report. */
  authority: string;
  phone?: string;
  email?: string;
  website?: string;
}

/** Every default is supplied, so the identity object is always fully populated. */
type CompleteIdentity = Required<SchoolIdentity>;

const DEFAULTS: CompleteIdentity = {
  name: 'Christ Church Co-Ed School',
  shortName: 'Christ Church Co-Ed',
  location: 'Gram Saliwada, Mandla Road, Jabalpur (M.P.), India',
  authority: 'Board of Education, Church of North India, Jabalpur Diocese',
  phone: '+91 72250 91111',
  email: 'cccssjalabpur@gmail.com',
  website: 'https://cccssj.in/',
};

export const SCHOOL: SchoolIdentity = {
  name: setting('VITE_SCHOOL_NAME', DEFAULTS.name),
  shortName: setting('VITE_SCHOOL_SHORT_NAME', DEFAULTS.shortName),
  location: setting('VITE_SCHOOL_LOCATION', DEFAULTS.location),
  authority: setting('VITE_SCHOOL_AUTHORITY', DEFAULTS.authority),
  phone: setting('VITE_SCHOOL_PHONE', DEFAULTS.phone),
  email: setting('VITE_SCHOOL_EMAIL', DEFAULTS.email),
  website: setting('VITE_SCHOOL_WEBSITE', DEFAULTS.website),
};