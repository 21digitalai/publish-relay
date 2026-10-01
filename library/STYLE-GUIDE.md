# Publish Relay Style Guide

Status: accepted Builder direction. Changes to the operator-sensitive choices at the end require Overseer or operator approval.

## Product direction

Publish Relay is a focused scheduling cockpit: calm, precise, dense, fast, and trustworthy. It uses a midnight operational canvas with restrained electric-lime scheduling signals. It is not a marketing site and must keep its own visual identity.

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

The tab icon reuses the header's `.brand-signal` lime ring and violet offset accent. `src/ui/favicon.svg` is its single source; the Core build also copies it to the stable `/favicon.svg` asset path so Hosted pages can link `/core-assets/favicon.svg` without duplicating the mark.

## Background publication feedback

Queue and Calendar share one visible-tab workspace-scoped job refresh owner in `src/ui/workflow.tsx`: about every 10 seconds and on tab focus/visibility return. Existing Status and Calendar published marks remain the persistent truth. Only a previously observed job changing to Published or terminal Failed creates a toast; initial hydration, reload, filter changes, retries, and unchanged polls do not. The status refresh never requires WebSocket/SSE.

The shared `PublicationToastStack` in `src/ui/feedback.tsx` renders at most three newest notices above the bottom safe area. A success headline names the provider (`Published on X`), shows the known account/handle, and offers `View post` only for a canonical HTTPS provider result URL; otherwise it offers `View details`. Success closes after about six seconds, pausing on hover or keyboard focus. Failure says `Post needs attention`, links to job details, and persists until dismissed or navigation. Dismissal changes no job state. The icon and headline carry meaning without color; success uses `success` and failure uses `danger` on the dark `surface-2` panel. The toast is keyboard reachable without stealing focus, with polite success and assertive actionable-failure announcements. Entry motion is restrained and removed to opacity-only under reduced motion.
LinkedIn member connections reuse the Accounts adapter picker and account row. The picker is visible only when the LinkedIn OAuth client pair is configured; the account row surfaces token-expiry/reconnect copy at seven days or less, with urgent three- and one-day states, and the Composer excludes expired destinations and does not offer media selection for a LinkedIn-only selection. No separate provider-specific account screen is introduced.

The shared authenticated workflow shell and Connected accounts page render the same on-visit LinkedIn expiry notice when an active member token has 7, 3, or 1 days left. It names the member, gives the exact local expiry date/time, and offers a direct Reconnect action. It is explicitly in-app/on-visit; there is no email or background notification channel. The notice is absent outside the warning window and reports account-health load or reconnect errors without hiding the rest of the page.

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

The rail user identity and active workspace label always render from the authenticated persisted shell profile. Initials derive from the display name. Connection copy must describe only bounded known session/account state; it must never invent a global platform-health claim.

Routes:

- `/login`, `/register`, `/forgot-password`
- `/onboarding/workspace`, `/onboarding/accounts`, `/onboarding/first-post`
- `/w/:workspace/queue`
- `/w/:workspace/calendar`
- `/w/:workspace/jobs/:jobId`
- `/w/:workspace/accounts`
- `/w/:workspace/settings/{workspace,automation,integrations}`

Workspace selection is a searchable popover showing name, role, and active-account count. Raw IDs never appear in normal workflows.

Queue search/view and calendar mode/date are URL-owned state so refresh and copied links preserve the operator's current context. Queue priority is deterministic: attention first, active work nearest-first, then history newest-first. Every workspace link derives from the active route; no fallback workspace slug is permitted.
Queue filter menus use the shared `FilterSelect` listbox primitive in `src/ui/workflow.tsx`; browser-native selects are not used. The trigger exposes expanded state, supports keyboard open/Escape close, and each option exposes selected state. All filters, sort, search, and view tabs share one URL-backed state owner and one complete reset action.

## Authentication and onboarding

Auth uses a centered 440px panel on the canvas with a restrained violet radial glow. No marketing carousel.

- In `magic_link` mode, `/login`, `/register`, and `/forgot-password` render the same email-only `AuthPage`: one submit requests a one-time link, and the receipt says to check email without revealing account existence. No name, workspace-name, password, or separate registration control appears. The development URL is visible only when explicitly supplied by the non-production API response.
- In `password` mode, login retains email/password, reveal toggle, forgot-password link, submit, and registration link; registration retains display name, email, password, and first workspace name. Submission atomically creates the user, first workspace, owner membership, and browser session.
- Errors are inline; server errors also receive a form summary.
- Loading preserves button dimensions and uses action-specific labels.
- First run has three steps: confirm/configure the workspace profile and slug created during registration, account connection or explicit skip, then first scheduled post or empty workspace. It must not create a duplicate workspace.
- OAuth leaves through a labeled secure redirect and returns to a real success/failure receipt.
- Fastify serves the built SPA from the same deployable. `/login`, `/register`, and `/forgot-password` are public; `/app`, `/onboarding/*`, and `/w/*` require a valid session and redirect unauthenticated users to `/login` before protected data is returned.
- The `/login` shell redirects an already authenticated visitor to `/app`; signed-out and expired-session visitors retain the normal login shell. The server, not a cookie-presence UI guess, owns this navigation state.
- Password-mode `/forgot-password` renders an honest unavailable/support state; magic-link mode shares the working email request surface.

## Connected accounts

Group by provider and show each connected account independently. Rows include provider logo, avatar, display name, handle, health, capabilities, last successful sync, and actions.

`src/ui/posting-adapter-registry.ts` is the single source of truth for adapters exposed by the connected-accounts picker. The Accounts page renders one **Add Posting Adapter** entry and iterates enabled registry entries for provider label, icon, description, OAuth start path, and pre-connect configuration requirements. Adding or disabling an adapter must not require picker markup changes. Provider-specific reconnect actions resolve through the same registry.

- Multiple accounts per provider are normal.
- Each provider group has Connect another.
- Search name/handle; filter provider, health, and workspace access.
- Reconnect is primary for expired credentials.
- LinkedIn Reconnect is account-specific: the callback must not report success for a different signed-in member. On mismatch, Accounts explains that the selected account was unchanged and offers another Reconnect attempt.
- LinkedIn tokens within seven days of expiry remain usable but show Needs attention consistently in the account summary, health filter, and row badge; expired tokens show Reconnect required. Exact expiry warnings include a timezone.
- Disconnect names the account, explains scheduled-job impact, and requires explicit confirmation.
- Meta rows distinguish local account disconnect from selected remote grant revoke. The latter names the selected destination, explains that its whole Meta login (all linked Page and Instagram destinations) is affected, and uses the existing destructive confirmation and inline error pattern; active jobs must be resolved first. Neither action exposes connection IDs in the UI.
- If a Meta revoke has been reserved but not locally finalized, its rows show `Revocation pending` with a Retry Revoke path. Reconnect is suppressed until that same grant completes cleanup; the row remains visible on reload rather than implying a new grant can replace it.
- Account rows load from the tenant-scoped account API. Connect and reconnect use provider-specific secure OAuth redirects for X, YouTube, and Meta; successful callbacks return to the protected workspace. One Meta group renders separate `Instagram · identity` and `Facebook · Page` destinations. `reauth_required`, `permission_lost`, and `remote_missing` destinations remain visible with reconnect guidance and cannot be selected for new schedules. YouTube rows expose an inline destination-defaults form for visibility, Made for Kids, and subscriber notification so routine schedules need only sparse overrides. Saving is explicit, disables during submission, and keeps errors inline. Disconnect remains blocked until referenced active jobs are cancelled, and the API error stays visible as actionable inline feedback.

## Composer

After active-workspace account loading, the composer shows a focused account gate when no active destination exists. The gate links to that workspace's Accounts route and hides all post controls; loading and fetch-error states remain distinct, with an inline Retry for errors.

An external-draft cockpit link opens the canonical Composer sheet directly. A compact imported-draft status banner names the friendly source label and attached-media count without exposing actor IDs, client IDs, internal storage fields, or raw provenance. All destination, content, timing, validation, success, and failure states remain owned by the existing Composer; there is no separate imported-draft editor.

The composer is a 640px right sheet on desktop, full-screen on mobile, and may expand to 880px for preview.
Its X, Escape, and backdrop-only dismissal all use the same cleanup-aware close path; inside-sheet clicks do not dismiss, saving prevents dismissal, and focus returns to the Create post trigger.

Order:

1. Visual multi-account picker grouped by provider.
2. Post body with target-specific capability/character feedback.
3. Media previews, progress, constraints, removal, and errors.
   The shared media control accepts one MP4 for a single YouTube destination, or up to four X images / one X GIF or MP4 for X-only destinations. It shows attached filenames and removal, validates type/count/size before upload, and uses the existing browser media lifecycle during schedule submission.
   If scheduling returns an uncertain server/network result, the Composer displays a recovery status, makes the content/destination/media/timing controls inert, and changes the primary action to “Confirm previous request.” The sheet cannot be closed or saved as a draft until the unchanged request resolves, preventing a visually replaced file from being submitted against an older upload receipt.
4. Now/Schedule segmented control.
5. Date-time picker with visible timezone.
6. Per-provider preview and validation.
7. Publish now or Schedule N posts.

Multi-account submission creates related independent jobs. Never silently drop incompatible targets. Offer 15-minute time suggestions while accepting minute precision. Block past times inline. Success becomes a compact receipt with job count, time, and Queue/Calendar links.

The composer schedule uses separate labeled native Date and Time controls with explicit picker buttons, minute precision, and a visible timezone. At 390px the controls stack. They still resolve through the existing local-time/DST choice and ISO submission contract; no scheduling presets are implied.
Meta uses the canonical Composer destination picker and content-shape picker. The destination is
chosen before content: Instagram offers single image and carousel, Facebook offers link and single
image, and selecting both shows only single image. The picker displays capability freshness and
keeps unavailable destinations visible but disabled. Image upload reuses the canonical hidden file
control/dropzone lifecycle; validation remains inline on desktop and mobile.

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

Published jobs use the shared success token plus a visible check/Published marker in Month, Week, Day, and Timeline. Compact mobile month cells retain the check and accessible Published link name. Fresh calendar loads derive this state from the workspace-scoped job DTO, not a transient toast.

Ship Month, Week, Day, and Timeline/hour modes. Preserve date and filters between modes. Header includes Today, navigation, date label, view switcher, timezone, and filters.

- Month shows up to three jobs then `+N more`; failures sort first within a day.
- Week/day uses a 24-hour grid, current-time line, and positioned job blocks.
- Timeline uses account lanes and 15-minute snapping.
- Dragging previews a new time and requires confirmation before persistence.
- Reschedule in job detail is the keyboard alternative.
- Overlaps stack visibly with account identity.
- Mobile defaults to agenda/day; month opens the selected day below.

## Job detail and recovery

Publication trust surfaces keep normalized server truth visible: `.queue-media` is the bounded media summary inside the canonical queue row; `.detail-content-parts` preserves provider-ready thread order; `.detail-media-gallery` renders ordered media and `.missing-media` makes unavailable assets explicit. `.external-result-link` is rendered only from the server-provided canonical provider URL—the browser never constructs provider links.

Job detail is a route-backed drawer on desktop and a page on mobile. Sections: status, account/provider, content/media, schedule/timezone, execution timeline, provider result, audit metadata, actions.

- Edit only before dispatch, with disabled reason.
- Cancellation explains that published external content cannot be undone.
- Retry shows failure, count, next automatic attempt, and safety.
- Manual retry is idempotent and never creates a duplicate visible job.
- Published jobs expose a provider-specific external link.
- Human error copy is primary; raw codes live under Technical details.

### Canonical workflow UI ownership

- `src/ui/workflow.tsx` owns the shared scheduling workflow primitives: status vocabulary, queue rows, calendar job blocks, composer, job detail, and destructive/retry confirmations.
- Queue, calendar, and job detail must reuse the same `Job` state contract and `Status` renderer so text, color, links, and recovery semantics cannot drift between surfaces.
- The composer remains one shared route-independent sheet opened from the rail; success receipts link to both Queue and Calendar.
- Calendar modes share the same job fixtures/DTO shape and route every block to the canonical deep-link job detail path.

## Components and states

- Buttons: brand primary, surface secondary, text tertiary, danger outlined until confirmation.
- Inputs: persistent label, optional hint, 1px border, 2px focus ring with 2px offset.
- Use searchable comboboxes; account selection is visual.
- Success/info may use toasts; validation and actionable failures remain inline/persistent.
- Dialogs trap and restore focus; destructive dialogs focus Cancel by default.
- Workspace settings Save and Create actions share the brand primary button contract. Settings cards use `surface-1` and the active tab underline uses `brand`; mobile settings actions have at least a 44px tap target.
- Composer body labels place the live destination-specific counter in a separate muted row above a full-width surface textarea; keyboard focus uses the shared violet outline.
- Skeletons mirror final geometry. No shell-level full-screen spinner.
- `WorkflowLoading` in `src/ui/workflow.tsx` is the canonical geometry-matched loading primitive for queue, calendar, and detail surfaces. Motion timing uses the shared `--motion-*` tokens in `src/ui/styles.css`; shimmer and entrance transforms are removed under reduced motion.
- `LiveRegion` in `src/ui/feedback.tsx` owns polite mutation announcements after server-confirmed state changes across workflow and account surfaces. Visible persistent errors remain separate `role="alert"` content.
- Account adapter settings and Composer provider overrides reuse the canonical `DefaultsSelect` listbox in `src/ui/defaults-select.tsx` rather than native selects; its body-level fixed portal prevents account cards and mobile containers from clipping menus. Account booleans use `.defaults-toggle` switches. Both expose explicit ARIA state and remain keyboard operable.
- Settings Integrations reuses the existing settings tab shell, card, API-key row, and inline confirmation primitives. It displays friendly client IDs, approved scopes, and connection dates; revocation is an explicit two-step action and never exposes tokens or internal workspace/user IDs.
- `/connect/authorize` reuses the focused authentication panel as the generic consent surface. It names the requesting application, lists every requested scope, provides explicit approve/cancel actions, and preserves the full authorization request through login without storing credentials in browser storage.
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
- No styling or composition copied from another scheduling product.

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

# YouTube composer

- The canonical publication composer in `src/ui/workflow.tsx` switches to a single-channel YouTube video flow only when exactly one YouTube destination is selected.
- Successful YouTube receipts render an allowlisted definition list with friendly visibility, Made for Kids, and subscriber-notification labels; internal settings keys and raw JSON never appear.
- It uploads one MP4 through the authenticated browser media endpoint before creating the post, exposes sparse per-publication overrides, and displays the returned effective settings snapshot in the receipt.
