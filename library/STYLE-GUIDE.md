# Publish Relay Style Guide

Status: accepted Builder direction. Changes to the operator-sensitive choices at the end require Overseer or operator approval.

## Product direction

Publish Relay is a focused scheduling cockpit: calm, precise, dense, fast, and trustworthy. It uses a midnight operational canvas with restrained electric-lime scheduling signals. It is not a marketing site and must not copy Postiz.

References:

- Raycast: compact dark surfaces and restrained borders.
- Cal.com: calendar-first temporal structure.
- Airtable: workflow hierarchy and explicit state.

Principles:

1. Time is spatial: preserve position, duration, timezone, and collisions.
2. State is explicit in text and icon; color only reinforces it.
3. Account identity always includes provider mark, avatar, name, and handle.
4. One dominant action per surface.
5. Dense, not cramped.
6. Recovery is first-class and actionable.

## Design tokens

### Color

| Token           |     Value | Use                        |
| --------------- | --------: | -------------------------- |
| `canvas`        | `#0B0C10` | app background             |
| `surface-1`     | `#11131A` | rail and panels            |
| `surface-2`     | `#181B24` | controls and selected rows |
| `surface-3`     | `#222632` | menus and pressed surfaces |
| `border`        | `#2C3140` | dividers and outlines      |
| `border-strong` | `#41485C` | emphasized boundaries      |
| `text`          | `#F4F6FA` | primary text               |
| `text-muted`    | `#A7ADBD` | secondary text             |
| `text-faint`    | `#747C90` | metadata and placeholders  |
| `brand`         | `#A3FF4F` | primary scheduling action  |
| `brand-pressed` | `#8BE53D` | pressed action             |
| `brand-ink`     | `#132007` | text on brand              |
| `focus`         | `#A98BFF` | focus ring and selection   |
| `info`          | `#63B3FF` | scheduled/info             |
| `success`       | `#4DD7A8` | published/connected        |
| `warning`       | `#FFC857` | retrying/attention         |
| `danger`        | `#FF6B7A` | failed/destructive         |

Normal text must meet 4.5:1 contrast and large text/UI boundaries 3:1. Semantic color never carries meaning alone.

### Typography and layout

- Font: `Inter Variable, ui-sans-serif, system-ui, sans-serif`.
- Use tabular numerals for dates, times, counts, and job IDs.
- `display`: 32/38, 650; auth/onboarding only.
- `h1`: 24/30, 650.
- `h2`: 18/24, 600.
- `body`: 14/20, 450.
- `body-strong`: 14/20, 600.
- `small`: 12/16, 500.
- `micro`: 11/14, 600, uppercase, `.04em` tracking.
- Base spacing 4px; scale 4, 8, 12, 16, 20, 24, 32, 48.
- App gutter: 24px desktop, 16px tablet, 12px mobile.
- Control heights: 32px compact, 40px default, 48px primary/mobile.
- Radius: 6px chips, 8px controls, 12px panels/dialogs, full avatars.
- Elevation uses surface + 1px border; menus/dialogs may add `0 16px 48px rgba(0,0,0,.42)`.
- Avoid nested floating cards. Lists and calendars share planes with dividers.
- Lucide-style icons at 16/18/20/24px with 1.75px stroke. No emoji controls.

## Information architecture

Desktop uses a 240px left rail with wordmark, workspace switcher, Create post, Queue, Calendar, Accounts, Settings, then help/user/connection health in the footer. Create post remains visible without scrolling. Mobile uses a drawer.

Routes:

- `/login`, `/register`, `/forgot-password`
- `/onboarding/workspace`, `/onboarding/accounts`, `/onboarding/first-post`
- `/w/:workspace/queue`
- `/w/:workspace/calendar`
- `/w/:workspace/jobs/:jobId`
- `/w/:workspace/accounts`
- `/w/:workspace/settings/{workspace,members,profile}`

Workspace selection is a searchable popover showing name, role, and active-account count. Raw IDs never appear in normal workflows.

## Authentication and onboarding

Auth uses a centered 440px panel on the canvas with a restrained violet radial glow. No marketing carousel.

- Login: email, password, reveal toggle, forgot password, submit, registration link.
- Registration: display name, email, password, first workspace name, visible requirements, terms acknowledgement. Submission atomically creates the user, first workspace, owner membership, and browser session.
- Errors are inline; server errors also receive a form summary.
- Loading preserves button dimensions and uses action-specific labels.
- First run has three steps: confirm/configure the workspace profile and slug created during registration, account connection or explicit skip, then first scheduled post or empty workspace. It must not create a duplicate workspace.
- OAuth leaves through a labeled secure redirect and returns to a real success/failure receipt.
- Fastify serves the built SPA from the same deployable. `/login`, `/register`, and `/forgot-password` are public; `/app`, `/onboarding/*`, and `/w/*` require a valid session and redirect unauthenticated users to `/login` before protected data is returned.
- Until a recovery-token delivery implementation is accepted, `/forgot-password` renders an honest non-enumerating unavailable/support state. It must not claim an email was sent.

## Connected accounts

Group by provider and show each connected account independently. Rows include provider logo, avatar, display name, handle, health, capabilities, last successful sync, and actions.

- Multiple accounts per provider are normal.
- Each provider group has Connect another.
- Search name/handle; filter provider, health, and workspace access.
- Reconnect is primary for expired credentials.
- Disconnect names the account, explains scheduled-job impact, and requires explicit confirmation.

## Composer

The composer is a 640px right sheet on desktop, full-screen on mobile, and may expand to 880px for preview.

Order:

1. Visual multi-account picker grouped by provider.
2. Post body with target-specific capability/character feedback.
3. Media previews, progress, constraints, removal, and errors.
4. Now/Schedule segmented control.
5. Date-time picker with visible timezone.
6. Per-provider preview and validation.
7. Publish now or Schedule N posts.

Multi-account submission creates related independent jobs. Never silently drop incompatible targets. Offer 15-minute time suggestions while accepting minute precision. Block past times inline. Success becomes a compact receipt with job count, time, and Queue/Calendar links.

## Queue

Use a dense data list, not cards. Toolbar: search; status/provider/account/workspace/date filters; sort; All, Needs attention, Upcoming, and Published views.

Desktop columns: status, scheduled time, excerpt/media, account, provider, created by, updated, actions. Rows are 64px default or 48px compact. Whole-row navigation must not interfere with checkboxes/actions. Bulk cancel only cancellable states with a count-confirmation.

State vocabulary:

- Draft: neutral dot + pencil.
- Scheduled: blue clock.
- Dispatching: violet spinner.
- Published: green check + external link.
- Retrying: amber rotate + next attempt.
- Failed: red alert + short reason.
- Cancelled: muted strike-circle.

## Calendar

Ship Month, Week, Day, and Timeline/hour modes. Preserve date and filters between modes. Header includes Today, navigation, date label, view switcher, timezone, and filters.

- Month shows up to three jobs then `+N more`; failures sort first within a day.
- Week/day uses a 24-hour grid, current-time line, and positioned job blocks.
- Timeline uses account lanes and 15-minute snapping.
- Dragging previews a new time and requires confirmation before persistence.
- Reschedule in job detail is the keyboard alternative.
- Overlaps stack visibly with account identity.
- Mobile defaults to agenda/day; month opens the selected day below.

## Job detail and recovery

Job detail is a route-backed drawer on desktop and a page on mobile. Sections: status, account/provider, content/media, schedule/timezone, execution timeline, provider result, audit metadata, actions.

- Edit only before dispatch, with disabled reason.
- Cancellation explains that published external content cannot be undone.
- Retry shows failure, count, next automatic attempt, and safety.
- Manual retry is idempotent and never creates a duplicate visible job.
- Published jobs expose a provider-specific external link.
- Human error copy is primary; raw codes live under Technical details.

## Components and states

- Buttons: brand primary, surface secondary, text tertiary, danger outlined until confirmation.
- Inputs: persistent label, optional hint, 1px border, 2px focus ring with 2px offset.
- Use searchable comboboxes; account selection is visual.
- Success/info may use toasts; validation and actionable failures remain inline/persistent.
- Dialogs trap and restore focus; destructive dialogs focus Cancel by default.
- Skeletons mirror final geometry. No shell-level full-screen spinner.
- Queue empty: Nothing scheduled yet + Create post.
- Filter empty: No jobs match these filters + Clear filters.
- Accounts empty: Connect your first account with explanation.
- Calendar remains visible when empty with a quiet inline prompt.

## Motion

- 100ms press, 160ms hover/focus, 220ms panel/navigation, 280ms success receipt.
- Entrances: `cubic-bezier(.2,.8,.2,1)`; feedback uses ease-out.
- Sheets translate 16px and fade.
- Calendar jobs animate only after confirmed persistence.
- Success uses a single check draw/fade; no confetti.
- Reduced motion removes transforms and limits opacity transitions to under 100ms.

## Responsive and accessibility

- `>=1280`: full rail and columns; all calendar modes.
- `768–1279`: 72px compact rail/drawer; hide low-value columns; popover filters.
- `<768`: full-screen composer/detail, drawer navigation, agenda-first calendar, two-line rows.
- Touch targets are at least 44px; no body-level horizontal scrolling.
- WCAG 2.2 AA, landmarks, skip link, logical headings, visible focus, full keyboard operation.
- Status is text + icon + color.
- Calendar follows ARIA grid behavior and exposes date/time/account/status.
- Live regions announce schedule, reschedule, cancel, retry, and validation results.
- Time always includes timezone; ambiguous DST requires explicit offset choice.

## Non-goals

- No promotional homepage, pricing, social proof, or marketing carousel.
- No glassmorphism, omnipresent neon gradients, oversized rounded cards, or decorative charts.
- No raw IDs, JSON, or provider error payloads in normal workflows.
- No native alert/confirm, browser-default select, or browser-only validation.
- No Postiz-identical styling or composition.

## Oracle verification

Builder must provide 1440px and 390px screenshots for auth, onboarding, accounts, queue, every calendar mode, composer, job detail, failed/retry, empty/loading/error, and destructive confirmations. Oracle verifies exact tokens, multiple accounts per provider, responsive behavior, keyboard operation, AA contrast, reduced motion, 44px mobile targets, and all named state transitions.

## Frozen operator-sensitive choices

- Dark-only initial theme.
- Electric-lime primary action with violet focus/selection.
- Left-rail shell.
- Right-sheet composer and full-screen mobile composer.
- Drag rescheduling requires confirmation.
- Mobile calendar defaults to agenda/day.
- Onboarding may skip account connection with explicit limitations.

Next design pass: after the first complete static shell and one populated queue/calendar dataset exist.
