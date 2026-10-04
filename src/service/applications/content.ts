/**
 * Applicant-facing copy, editable from the operations page (Applicant page content).
 *
 * Copy only. The defaults below are the single source of truth for every editable string on the
 * applicant site; overrides are stored server-side (site_content table) and merged at request time,
 * so a change is live on the next page render. Keys, routes, field names, option values, states and
 * automation config are never touched by this module: an option's stored value stays `part_time`
 * however its label is edited. Values are plain text (rendered with textContent on the applicant page).
 */
import type Database from 'better-sqlite3';

export interface ContentField {
  key: string;
  group: string;
  label: string;
  def: string;
  max: number;
  multiline?: boolean;
  /** May be saved empty (the applicant page simply omits it). */
  optional?: boolean;
  /** Placeholders the text may contain, e.g. {n} (code length), {name} (first name). */
  vars?: string[];
}

export interface ContentFieldView extends ContentField {
  value: string;
  custom: boolean;
  updatedAt: number | null;
}

export const CONTENT_GROUPS = ['Brand', 'Landing', 'Personal details', 'Date of birth', 'Address', 'Verification', 'Questions', 'Preparing / errors', 'Role ready', 'Legal pages'] as const;

const f = (key: string, group: string, label: string, def: string, max = 120, extra: Partial<ContentField> = {}): ContentField => ({ key, group, label, def, max, ...extra });

const PRIVACY = `Last updated: {year}\n\n## Who we are\n{brand} Careers runs this application site so you can apply for logistics and delivery roles with {brand}. This policy explains what we collect when you apply and how we use it.\n\n## What we collect\n- Your name, mobile number and email address, so we can contact you about your application.\n- Your date of birth and home address, which are needed to set up your onboarding record. They are not used to evaluate your application.\n- Your answers to the short questions about experience, schedule and availability.\n- The verification code you enter. It is used once to prepare your application and is never stored.\n- Technical information needed to run the site, such as the time of your visit and the steps you completed.\n\n## How we use it\n- To prepare your application and your onboarding record.\n- To show you your role details once they are ready.\n- To contact you about your application.\n- To keep the site secure and to understand how applicants move through the application.\n\n## Sharing\nWe share your information only with service providers that process applications on our behalf and only for that purpose. We do not sell your information.\n\n## Cookies\nThe site sets one first-party cookie that keeps your application session so you can return and continue where you left off. It does not track you across other sites.\n\n## Keeping your information\nWe keep application information for as long as needed to process your application and to meet our legal and business record-keeping obligations, then delete or anonymise it.\n\n## Your choices\nYou can ask us what information we hold about you, ask us to correct it, or ask us to delete it. Use the details on the Contact page.\n\n## Changes\nIf this policy changes, the new version will be published here with a new date.`;
const TERMS = `Last updated: {year}

## Using this site
This site lets you apply for roles with {brand}. By using it you agree to these terms.

## Your information
You confirm that the information you enter is accurate and belongs to you, and that the address you provide matches the address on your government-issued ID.

## No guarantee of a role
Completing the application does not guarantee an offer, an interview or a start date. {brand} decides on applications according to its own process.

## Acceptable use
Do not use the site in a way that interferes with it, attempts to access other people's applications, or submits false information.

## Availability
We may change or withdraw parts of the site at any time. We do our best to keep it available but do not promise uninterrupted access.

## Changes to these terms
If these terms change, the new version will be published here with a new date.

## Questions
Use the details on the Contact page.`;
const CONTACT = `Questions about your application, or about how we handle your information? Reach us using the details below and include the name you applied with so we can find your application quickly.`;

/** Static copy (the question screens add their own fields from config/apply-questions.json). */
export const STATIC_FIELDS: ContentField[] = [
  // Landing
  f('landing.pill', 'Landing', 'Earnings pill', 'Earn up to $1,800 / week', 40),
  // The company / site name. {brand} in any other text is replaced with it (applicant pages, legal pages, page titles, operator pages).
  f('brand.name', 'Brand', 'Company / site name ({brand} everywhere else becomes this)', 'Shipzora', 40),
  f('brand.tabTitle', 'Brand', 'Browser tab title of the application', 'Apply to {brand}', 60, { vars: ['{brand}'] }),
  f('brand.siteTitle', 'Brand', 'Site title used after legal page titles and in the operations pages', '{brand} Careers', 60, { vars: ['{brand}'] }),
  f('brand.headerLanding', 'Brand', 'Header word after the company name on the landing page', 'Careers', 30),
  f('brand.headerSteps', 'Brand', 'Header word after the company name on the application steps', 'Application', 30),
  f('landing.title', 'Landing', 'Hero headline (one line per row; the company name is shown in yellow)', 'Drive with {brand}.\nDeliver Success.', 80, { multiline: true, vars: ['{brand}'] }),
  f('landing.subtitle', 'Landing', 'Hero supporting sentence', 'Flexible schedules: Full-time, Part-time, or Students.', 140),
  f('landing.trust1', 'Landing', 'Trust row: item 1 (check icon)', 'Progress saved', 24),
  f('landing.trust2', 'Landing', 'Trust row: item 2 (lock icon)', 'Secure', 24),
  f('landing.trust3', 'Landing', 'Trust row: item 3 (clock icon)', '5 min', 24),
  f('landing.cta', 'Landing', 'Start button', 'Start Driving Today', 40),
  f('landing.copyright', 'Landing', 'Copyright line under the button ({year} = current year)', '© {year} {brand}', 60, { vars: ['{year}', '{brand}'] }),
  f('landing.welcome.eyebrow', 'Landing', 'Saved application: small label', 'Saved application', 40),
  f('landing.welcome.title', 'Landing', 'Saved application: title (name is appended when known)', 'Welcome back', 40),
  f('landing.welcome.inProgress', 'Landing', 'Saved application: in progress text', 'You have an application in progress. Pick up where you left off.', 160),
  f('landing.welcome.ready', 'Landing', 'Saved application: role details ready text', 'Your role details are ready to view.', 160),
  f('landing.welcome.resume', 'Landing', 'Saved application: resume button', 'Continue application', 40),
  f('landing.welcome.view', 'Landing', 'Saved application: view role details button', 'View role details', 40),
  f('landing.welcome.new', 'Landing', 'Saved application: start over link', 'Start a new application instead', 60),
  // Personal details
  f('contact.title', 'Personal details', 'Heading', 'Tell us about yourself', 60),
  f('contact.intro', 'Personal details', 'Supporting text', 'We’ll use these details to contact you about your application.', 200),
  f('contact.firstName.label', 'Personal details', 'First name: label', 'First name', 40),
  f('contact.firstName.help', 'Personal details', 'First name: helper text', 'Use your full first name.', 120),
  f('contact.lastName.label', 'Personal details', 'Last name: label', 'Last name', 40),
  f('contact.lastName.help', 'Personal details', 'Last name: helper text', 'As it appears on your ID.', 120),
  f('contact.phone.label', 'Personal details', 'Mobile phone: label', 'Mobile phone', 40),
  f('contact.phone.help', 'Personal details', 'Mobile phone: helper text', 'A number we can text or call.', 120),
  f('contact.email.label', 'Personal details', 'Email: label', 'Email', 40),
  f('common.continue', 'Personal details', 'Continue button (all steps)', 'Continue', 30),
  // Date of birth
  f('dob.title', 'Date of birth', 'Heading', 'Your date of birth', 60),
  f('dob.intro', 'Date of birth', 'Supporting text', 'We need this to set up your onboarding record. It isn’t used to evaluate your application.', 220),
  f('dob.legend', 'Date of birth', 'Field label', 'Date of birth', 40),
  // Address
  f('address.title', 'Address', 'Heading', 'Your home address', 60),
  f('address.intro', 'Address', 'Supporting text', 'Enter the address where you currently live.', 200),
  f('address.street.label', 'Address', 'Street address: label', 'Street address', 40),
  f('address.street.help', 'Address', 'Street address: helper text', 'Enter the street address shown on your driver’s license.', 140),
  f('address.city.label', 'Address', 'City: label', 'City', 40),
  f('address.state.label', 'Address', 'State: label', 'State', 40),
  f('address.zip.label', 'Address', 'ZIP code: label', 'ZIP code', 40),
  f('address.confirm.title', 'Address', 'Confirmation sheet: heading', 'Does this match your ID?', 60),
  f('address.confirm.text', 'Address', 'Confirmation sheet: text', 'Please make sure this address is exactly as shown on your driver’s license. We use it to verify your identity, so it has to match.', 240),
  f('address.confirm.yes', 'Address', 'Confirmation sheet: confirm button', 'Yes, it matches my ID', 40),
  f('address.confirm.edit', 'Address', 'Confirmation sheet: edit button', 'Edit address', 40),
  // Verification
  f('code.title', 'Verification', 'Heading', 'Verification code', 60),
  f('code.intro', 'Verification', 'Supporting text', 'Enter the verification code provided for your {brand} application.', 220, { vars: ['{brand}'] }),
  f('code.label', 'Verification', 'Field label', '{n}-digit code', 40, { vars: ['{n}'] }),
  f('code.note', 'Verification', 'Helper text under the field', 'Type or paste the code as it appears in the message; dashes and spaces are removed. It is used once and never stored.', 160),
  f('code.retry', 'Verification', 'Retry message (after a problem)', 'We couldn’t finish the previous step. Your details are saved. Enter your verification code again to try again.', 220),
  f('code.received', 'Verification', 'Code already received message', 'Your verification code has been received. You can continue with your application.', 200),
  f('code.invalid', 'Verification', 'Validation message', 'Enter the {n}-digit verification code.', 120, { vars: ['{n}'] }),
  f('code.cta', 'Verification', 'Continue button', 'Continue', 30),
  // Preparing / errors
  f('preparing.badge', 'Preparing / errors', 'Preparing: badge', 'Preparing', 30),
  f('preparing.title', 'Preparing / errors', 'Preparing: heading', 'Preparing your role details…', 60),
  f('preparing.intro', 'Preparing / errors', 'Preparing: supporting text ({name} = first name, when known)', 'Thanks{name}. We’re getting your role information ready. This page will update on its own when it’s available.', 220, { vars: ['{name}'] }),
  f('preparing.note', 'Preparing / errors', 'Preparing: note (first 20 seconds)', 'This usually takes less than a minute. Keep this page open.', 200),
  f('preparing.noteLong', 'Preparing / errors', 'Preparing: note after 20 seconds', 'Taking a little longer than usual. Please keep this page open. It updates automatically.', 220),
  f('preparing.noteVeryLong', 'Preparing / errors', 'Preparing: note after 60 seconds', 'Almost there. Please stay on this page; your role details will appear here the moment they’re ready.', 220),
  f('preparing.stage1', 'Preparing / errors', 'Preparing: progress step 1', 'Application received', 40),
  f('preparing.stage2', 'Preparing / errors', 'Preparing: progress step 2', 'Verifying your details', 40),
  f('preparing.stage3', 'Preparing / errors', 'Preparing: progress step 3', 'Preparing your role details', 40),
  f('preparing.readyTitle', 'Preparing / errors', 'Browser tab title when the link is ready', 'Your role details are ready', 60),
  f('problem.badge', 'Preparing / errors', 'Problem: badge', 'Action needed', 30),
  f('problem.title', 'Preparing / errors', 'Problem: heading', 'We couldn’t finish preparing your role details', 80),
  f('problem.fallback', 'Preparing / errors', 'Problem: default explanation', 'We couldn’t finish this step. Please try again.', 160),
  f('problem.note', 'Preparing / errors', 'Problem: saved-progress note', 'Your answers are saved. To try again, enter your verification code once more.', 200),
  f('problem.cta', 'Preparing / errors', 'Problem: button', 'Try again', 30),
  f('incomplete.badge', 'Preparing / errors', 'Missing information: badge', 'Almost there', 30),
  f('incomplete.title', 'Preparing / errors', 'Missing information: heading', 'Almost there', 60),
  f('incomplete.intro', 'Preparing / errors', 'Missing information: text', 'Some information is still missing before we can prepare your role details.', 200),
  f('incomplete.cta', 'Preparing / errors', 'Missing information: button', 'Review my application', 40),
  f('notice.reconnecting', 'Preparing / errors', 'Connection notice', 'Reconnecting… your progress is saved.', 100),
  f('notice.startFailed', 'Preparing / errors', 'Could not start notice', 'We couldn’t start your application just now. Please try again in a moment.', 160),
  f('notice.saveFailed', 'Preparing / errors', 'Could not save notice', 'Something in this step could not be saved. Please check your entries and try again.', 160),
  f('notice.missing', 'Preparing / errors', 'Missing information notice', 'Please complete the highlighted information to continue.', 120),
  // Role ready
  f('ready.badge', 'Role ready', 'Badge', 'One last step', 30),
  f('ready.badgeConfirmed', 'Role ready', 'Badge once confirmed', 'Confirmed', 30),
  f('ready.title', 'Role ready', 'Heading ({name} = first name)', '{name}, one quick verification', 80, { vars: ['{name}'] }),
  f('ready.titleNoName', 'Role ready', 'Heading when the name is unknown', 'Your role details are ready', 80),
  f('ready.intro', 'Role ready', 'Supporting paragraph', 'Thanks for completing your {brand} application. A short verification is needed before we show your role details. It only takes a moment.', 220),
  f('ready.check1', 'Role ready', 'Checklist: item 1', 'Contact details received', 60),
  f('ready.check2', 'Role ready', 'Checklist: item 2', 'Home address received', 60),
  f('ready.check3', 'Role ready', 'Checklist: item 3 (shown as the NEXT step, not done)', 'Identity verification', 60),
  f('ready.nextLabel', 'Role ready', 'Checklist: small label on the next step', 'Next', 16),
  f('ready.noteNew', 'Role ready', 'Secondary paragraph (before opening)', 'Tip: roles fill up quickly, so it is best to finish this step now while everything is fresh.', 180),
  f('ready.noteOpened', 'Role ready', 'Secondary paragraph (after opening)', 'Closed the verification by accident? No problem, just continue again from here. Sooner is better, roles fill up quickly.', 180),
  f('ready.noteConfirmed', 'Role ready', 'Secondary paragraph (confirmed)', 'Your role details have been confirmed.', 160),
  f('ready.cta', 'Role ready', 'Final button', 'Continue to verification', 40),
  f('ready.ctaAgain', 'Role ready', 'Final button (after opening)', 'Open Role Details again', 40),
  // Legal pages (/privacy, /terms, /contact). Bodies are plain text with light structure: a line starting with
  // "## " is a heading, "- " a bullet, a blank line separates paragraphs; {year} = current year. Drafts: review with counsel.
  f('legal.privacy.title', 'Legal pages', 'Privacy page: title', 'Privacy Policy', 60),
  f('legal.privacy.body', 'Legal pages', 'Privacy page: text (DRAFT: review with your legal counsel). "## " = heading, "- " = bullet, blank line = new paragraph', PRIVACY, 20000, { multiline: true, vars: ['{year}'] }),
  f('legal.terms.title', 'Legal pages', 'Terms page: title', 'Terms of Use', 60),
  f('legal.terms.body', 'Legal pages', 'Terms page: text (DRAFT: review with your legal counsel). "## " = heading, "- " = bullet, blank line = new paragraph', TERMS, 20000, { multiline: true, vars: ['{year}'] }),
  f('legal.contact.title', 'Legal pages', 'Contact page: title', 'Contact us', 60),
  f('legal.contact.body', 'Legal pages', 'Contact page: text', CONTACT, 4000, { multiline: true }),
  f('legal.contact.email', 'Legal pages', 'Contact page: support email (shown as a link; leave empty to hide)', '', 120, { optional: true }),
  f('legal.contact.phone', 'Legal pages', 'Contact page: phone (leave empty to hide)', '', 40, { optional: true }),
  f('legal.contact.hours', 'Legal pages', 'Contact page: hours (leave empty to hide)', '', 120, { optional: true }),
  f('legal.contact.address', 'Legal pages', 'Contact page: postal address (one line per row; leave empty to hide)', '', 300, { multiline: true, optional: true }),
];

interface QuestionsFile { screens?: { id: string; title: string; questions: { key: string; label: string; options: { value: string; label: string; hint?: string }[] }[] }[] }

/** Fields for the question screens: titles, question wording, option labels and hints. Values are never editable. */
export function questionFields(questions: QuestionsFile): ContentField[] {
  const out: ContentField[] = [];
  for (const s of questions.screens ?? []) {
    out.push(f(`screen.${s.id}.title`, 'Questions', `${s.title}: heading`, s.title, 60));
    for (const q of s.questions) {
      out.push(f(`q.${q.key}.label`, 'Questions', `${s.title}: question`, q.label, 140));
      for (const o of q.options) {
        out.push(f(`opt.${q.key}.${o.value}.label`, 'Questions', `${s.title}: option “${o.label}” (stored value: ${o.value})`, o.label, 60));
        if (o.hint !== undefined) out.push(f(`opt.${q.key}.${o.value}.hint`, 'Questions', `${s.title}: option “${o.label}” hint`, o.hint, 100));
      }
    }
  }
  return out;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export class ApplicantContent {
  private readonly fields = new Map<string, ContentField>();
  private overrides = new Map<string, { value: string; updatedAt: number }>();

  constructor(private readonly db: Database.Database, questions: QuestionsFile) {
    for (const fld of [...STATIC_FIELDS, ...questionFields(questions)]) this.fields.set(fld.key, fld);
    this.reload();
  }

  reload(): void {
    this.overrides = new Map();
    for (const row of this.db.prepare('SELECT key, value, updated_at FROM site_content').all() as { key: string; value: string; updated_at: number }[]) {
      if (this.fields.has(row.key)) this.overrides.set(row.key, { value: row.value, updatedAt: row.updated_at });
    }
  }

  /** Merged copy for the applicant page: every key, override or default. */
  /** The company / site name (brand.name). */
  brandName(): string { return (this.overrides.get('brand.name')?.value ?? this.fields.get('brand.name')?.def ?? 'Shipzora').trim() || 'Shipzora'; }
  /** Server-side placeholder substitution for rendered pages ({brand}, {year}). */
  fill(text: string): string { return text.replace(/\{brand\}/g, this.brandName()).replace(/\{year\}/g, String(new Date().getFullYear())); }

  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, fld] of this.fields) out[k] = this.overrides.get(k)?.value ?? fld.def;
    return out;
  }

  /** For the operations page. */
  list(): { groups: readonly string[]; fields: ContentFieldView[] } {
    const fields = [...this.fields.values()].map((fld) => {
      const o = this.overrides.get(fld.key);
      return { ...fld, value: o?.value ?? fld.def, custom: !!o, updatedAt: o?.updatedAt ?? null };
    });
    return { groups: CONTENT_GROUPS, fields };
  }

  /**
   * Save overrides: `null` resets a key to its default. Plain text only: control characters are dropped,
   * newlines are kept only for multiline fields, and the field's length limit applies.
   * Returns the keys that changed or a per-key error.
   */
  save(values: Record<string, string | null>): { saved: string[]; errors: Record<string, string> } {
    const saved: string[] = [];
    const errors: Record<string, string> = {};
    const up = this.db.prepare('INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    const del = this.db.prepare('DELETE FROM site_content WHERE key = ?');
    const now = Date.now();
    this.db.transaction(() => {
      for (const [key, raw] of Object.entries(values)) {
        const fld = this.fields.get(key);
        if (!fld) { errors[key] = 'unknown field'; continue; }
        if (raw === null || raw === undefined) { del.run(key); saved.push(key); continue; }
        if (typeof raw !== 'string') { errors[key] = 'text expected'; continue; }
        let text = raw.replace(CONTROL, '').replace(/\r\n?/g, '\n');
        text = fld.multiline ? text.split('\n').map((l) => l.trim()).join('\n').trim() : text.replace(/\n/g, ' ').trim();
        if (!text && !fld.optional) { errors[key] = 'cannot be empty (reset it to use the default)'; continue; }
        if (text.length > fld.max) { errors[key] = `at most ${fld.max} characters`; continue; }
        if (text === fld.def) del.run(key); else up.run(key, text, now);
        saved.push(key);
      }
    })();
    this.reload();
    return { saved, errors };
  }
}
