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

The Connected Accounts row marks a Facebook Page shared from another workspace with its friendly origin workspace name. Its local disconnect, grant revoke and reconnect actions are absent on that row; the origin workspace continues to own those actions. The same account list supplies the Composer destination picker without duplicating a Page or credential.
For target owners, that shared Page row also reuses the existing `.defaults-toggle` switch as `.account-calendar-visibility-toggle` for “Show posts from other workspaces.” It starts on, saves immediately with persistent inline error and live success feedback, and explains that turning it off hides only mirrored calendar posts in this workspace. It never disconnects the Page or pauses publishing. Non-owners see the account without the management switch.
The same display-only switch appears on a Facebook Page in its origin workspace for the origin owner, using that Page's self-exposure preference. Other provider rows do not show it.
The Calendar alone merges narrow, bounded shared-Page job summaries with its target-owned jobs by job ID. Every mirrored card names the post-origin workspace and links to a separate read-only Calendar detail; Queue and its editable job detail remain target-owned only. The mirrored detail reuses the existing job-detail shell, status, media gallery and back-link patterns but shows no edit, cancel or retry controls. It fetches exact target-authorized caption and job-bound previews rather than opening the origin workspace. Calendar day grouping, hour placement and visible-window boundaries use the current workspace timezone, including 23/25-hour DST days; an unavailable timezone or mirror feed is a visible Calendar error, not a silently incomplete view.
Mirrored Calendar cards in Month, Week, Day, and Timeline use the same compact lime `.calendar-origin-badge` with the actual `From <workspace>` label; the accent denotes origin, never failure or publication state. Mobile Week keeps enough horizontal day width for overlapping cards to show the full origin label, scrolling the grid horizontally. Compact mobile Month dots retain a lime outline and the full origin in the link's accessible name. Status coloring and read-only detail navigation remain unchanged.
Day and Week cards occupying nearby times share the available day column horizontally via the canonical `layoutCalendarBlocks` geometry helper; a later non-overlapping card regains full width. This keeps separate Page cards visible and clickable even when Page-wide scheduling intentionally uses nearby minutes.
Composer keeps its existing nearby-publication advisory and Use next 15-minute opening control. For Facebook Pages, that advisory counts Page-wide occupied instants across exposed workspaces without showing another workspace post content or identity; it never disables intentional same-minute scheduling. Non-Page destinations keep their existing workspace-scoped guidance.
Accounts and the Composer destination picker both offer a secondary `Load more accounts` control when the server returns an account page cursor. It preserves already loaded accounts and current Composer selection, disables itself while loading, and remains retryable after a visible error. `.accounts-load-more` and `.composer-load-more-accounts` are semantic anchors on the existing secondary button pattern, not new visual controls.

Queue and Calendar share one visible-tab workspace-scoped job refresh owner in `src/ui/workflow.tsx`: about every 10 seconds and on tab focus/visibility return. Existing Status and Calendar published marks remain the persistent truth. Only a previously observed job changing to Published or terminal Failed creates a toast; initial hydration, reload, filter changes, retries, and unchanged polls do not. The status refresh never requires WebSocket/SSE.

The shared `PublicationToastStack` in `src/ui/feedback.tsx` renders at most three newest notices above the bottom safe area. A success headline names the provider (`Published on X`), shows the known account/handle, and offers `View post` only for a canonical HTTPS provider result URL; otherwise it offers `View details`. Success closes after about six seconds, pausing on hover or keyboard focus. Failure says `Post needs attention`, links to job details, and persists until dismissed or navigation. Dismissal changes no job state. The icon and headline carry meaning without color; success uses `success` and failure uses `danger` on the dark `surface-2` panel. The toast is keyboard reachable without stealing focus, with polite success and assertive actionable-failure announcements. Entry motion is restrained and removed to opacity-only under reduced motion.
LinkedIn member connections reuse the Accounts adapter picker and account row. The picker is visible only when the LinkedIn OAuth client pair is configured; the account row surfaces token-expiry/reconnect copy at seven days or less, with urgent three- and one-day states, and the Composer excludes expired destinations and keeps media selection hidden for Text and Article. Its existing destination-first content picker distinguishes Text from Article link. Article link asks for HTTPS source, explicit title and optional description and explains that LinkedIn will not scrape those preview fields. A URL typed into Text remains an ordinary text post. Optional article thumbnails remain separate work; no raw image URN control is exposed. No separate provider-specific account screen is introduced.
For LinkedIn member single-image posts, the same destination-first Composer offers a `single image` kind and reuses the styled media picker, upload/remove lifecycle, post body, and receipt. It accepts one JPEG or PNG up to 5,000,000 bytes (decimal 5 MB), matching server admission, not a raw image URN or a media picker on Text/Article. The action stays disabled until both text and image are present; invalid type/count/size is inline before upload. This does not add article thumbnails, multiple images, company destinations, or a separate LinkedIn form.

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

Workspace Settings uses the existing `confirm-dialog` for deletion of an empty, non-current
owned workspace. The row action is disabled with a reason for current, last, or non-owned rows;
the dialog requires the exact displayed name and renders server resource blockers inline.
The list and switcher remove a deleted workspace after the response and stay absent on reload.
On narrow screens, row actions wrap below the workspace label.

`src/ui/confirmation-dialog.tsx` owns the shared alert-dialog shell for Queue job cancel/retry
and Snapchat Story verified-failure confirmation. It keeps the cancel action initially focused,
uses one labelled modal/action order, and accepts the caller's explanatory text, icon, button
labels, tone, pending state, and action handlers. The caller retains its own mutation and
close/error lifecycle; do not duplicate the shell for another job recovery confirmation.

Desktop uses a 240px left rail with wordmark, workspace switcher, Create post, Queue, Calendar, Accounts, Settings, then help/user/connection health in the footer. Create post remains visible without scrolling. Mobile uses a drawer.

The workspace switcher in `src/ui/main.tsx` keeps its Add new workspace link after the searchable workspace list, outside the listbox so filtering to zero matches never hides it. The link uses the active workspace's existing Settings > Workspace creation route; it does not create a second form. It remains keyboard reachable, and Escape from the link closes the menu and restores focus to the switcher.

The rail user identity and active workspace label always render from the authenticated persisted shell profile. Initials derive from the display name. Connection copy must describe only bounded known session/account state; it must never invent a global platform-health claim.
The workspace switcher and rail links derive the active workspace from that authenticated profile ID, never from the URL slug or the first workspace in a list. Direct deep links to another workspace are redirected to the current session workspace; changing workspaces requires the switcher, which rotates the session before navigating.

Routes:

- `/login`, `/register`, `/forgot-password`
- `/onboarding/workspace`, `/onboarding/accounts`, `/onboarding/first-post`
- `/w/:workspace/queue`
- `/w/:workspace/calendar`
- `/w/:workspace/jobs/:jobId`
- `/w/:workspace/accounts`
- `/w/:workspace/settings/{workspace,automation,integrations}`

Workspace selection is a searchable popover showing name, role, and active-account count. Raw IDs never appear in normal workflows.

Queue search/view and calendar mode/date are URL-owned state so refresh and copied links preserve the operator's current context. Queue priority is deterministic: attention first, active work nearest-first, then history newest-first. Workspace navigation uses the authenticated active workspace profile; a mismatched route redirects to that workspace before the shell renders.
Queue filter menus use the shared `FilterSelect` listbox primitive in `src/ui/workflow.tsx`; browser-native selects are not used. The trigger exposes expanded state, supports keyboard open/Escape close, and each option exposes selected state. All filters, sort, search, and view tabs share one URL-backed state owner and one complete reset action.

## Authentication and onboarding

Auth uses a centered 440px panel on the canvas with a restrained violet radial glow. No marketing carousel.

- In `magic_link` mode, `/login`, `/register`, and `/forgot-password` render the same email-only `AuthPage`: one submit requests a one-time link, and the receipt says to check email without revealing account existence. No name, workspace-name, password, or separate registration control appears. The development URL is visible only when explicitly supplied by the non-production API response.
- `src/ui/analytics-events.ts` is Core's optional, privacy-minimal browser action hook for embedding hosts. It dispatches typed `publish-relay-analytics` CustomEvents for accepted magic-link requests, successful explicit workspace creation, explicit provider-connect attempts, composer opens, and fixed-category visible errors in auth, connection, composer, scheduling, and publishing. Use `showAnalyticsError` at the state transition that surfaces an inline error, never during render. A newly visible asynchronous load failure or derived validation alert emits once on its false-to-true transition; rerenders and persistent messages do not emit again. Core never stores or transmits analytics. Host compositions may listen and validate the event independently. Never put emails, content, account identifiers, provider payloads, or raw errors into its properties. Session, connection, and publication success counts remain authoritative Core database facts rather than browser assertions.
- Workspace identity and settings errors use the existing `auth` area; connection initiation and callback mismatches use `connection`. A failed publication shown in the detail or notification surface emits a `publishing/provider` impression without asserting a successful or failed provider action as a browser fact.
- In `password` mode, login retains email/password, reveal toggle, forgot-password link, submit, and registration link; registration retains display name, email, password, and first workspace name. Submission atomically creates the user, first workspace, owner membership, and browser session.
- Errors are inline; server errors also receive a form summary.
- Loading preserves button dimensions and uses action-specific labels.
- First run has three steps: confirm/configure the workspace profile and slug created during registration, account connection or explicit skip, then first scheduled post or empty workspace. It must not create a duplicate workspace.
- OAuth leaves through a labeled secure redirect and returns to a real success/failure receipt.
- Fastify serves the built SPA from the same deployable. `/login`, `/register`, and `/forgot-password` are public; `/app`, `/onboarding/*`, and `/w/*` require a valid session and redirect unauthenticated users to `/login` before protected data is returned.
- The `/login` shell redirects an already authenticated visitor to `/app`; signed-out and expired-session visitors retain the normal login shell. The server, not a cookie-presence UI guess, owns this navigation state.
- Password-mode `/forgot-password` renders an honest unavailable/support state; magic-link mode shares the working email request surface.

## Connected accounts

Connected X rows reuse the inline `.defaults-toggle` switch to save an account-scoped long-post self-declaration immediately. The switch defaults off, labels the choice as self-declared, warns that X may reject longer posts, and shows pending/error/saved states without claiming verified Premium access. Reconnect-required rows cannot edit it until reconnected.

Origin-owned Facebook Page rows expose a `Share with workspaces` control in Accounts. Its anchored panel lists only other workspaces the current user owns; each workspace is a keyboard-operable checkbox button with explicit checked, saving, error, and confirmation states. The owner controls only visibility of the same Page connection, never a copied credential or account. Shared target rows show their origin label and omit origin-owned management actions. `src/ui/facebook-page-exposure-control.tsx` owns the panel and the paginated exposure selection load; AccountRow supplies the origin workspace identity.

Group by provider and show each connected account independently. Rows include provider logo, avatar, display name, handle, health, capabilities, last successful sync, and actions.

`src/ui/posting-adapter-registry.ts` is the single source of truth for adapters exposed by the connected-accounts picker. The Accounts page renders one **Add Posting Adapter** entry and iterates enabled registry entries for provider label, icon, description, OAuth start path, and pre-connect configuration requirements. Adding or disabling an adapter must not require picker markup changes. Provider-specific reconnect actions resolve through the same registry.

Facebook Pages and Instagram are separate picker entries and reconnect paths. Facebook Pages uses its own Meta Page consent; Instagram starts the dedicated Page-free Instagram Login path. The old combined Meta start and Facebook-Login Instagram start return unavailable results. A split Meta family disconnect is explicitly local and affects only that family's destinations, never remote app-level permission while another family may exist. Accounts shows the selected destination label and family-specific callback guidance without exposing consent state or provider errors. A newly connected Instagram Login row displays `Needs attention` with explicit `publishing is not yet available` guidance and remains disabled in Composer until its publishing transport ships; this is not a reconnect prompt.

- Multiple accounts per provider are normal.
- Each provider group has Connect another.
- Search name/handle; filter provider, health, and workspace access.
- Reconnect is primary for expired credentials.
- LinkedIn Reconnect is account-specific: the callback must not report success for a different signed-in member. On mismatch, Accounts explains that the selected account was unchanged and offers another Reconnect attempt.
- LinkedIn, Facebook Pages, and Instagram Login OAuth callback failures return to the canonical Accounts error alert with fixed provider-specific guidance and an existing fresh Connect/Reconnect action. Instagram Login distinguishes missing required permissions, no eligible professional account, expired state, and generic provider failure. The known LinkedIn unauthorized-scope result explains missing OpenID Connect app access; other permission denials remain generic. Meta service errors say the connection did not complete and offer a fresh attempt or support, without guessing the Graph cause. The UI never renders provider error text, raw callback query, code, or state; analytics emits only the fixed `connection/provider` category.
- LinkedIn tokens within seven days of expiry remain usable but show Needs attention consistently in the account summary, health filter, and row badge; expired tokens show Reconnect required. Exact expiry warnings include a timezone.
- Disconnect names the account, explains scheduled-job impact, and requires explicit confirmation.
- Meta rows distinguish local account disconnect from selected remote grant revoke. The latter names the selected destination, explains that its whole Meta login (all linked Page and Instagram destinations) is affected, and uses the existing destructive confirmation and inline error pattern; active jobs must be resolved first. Neither action exposes connection IDs in the UI.
- If a Meta revoke has been reserved but not locally finalized, its rows show `Revocation pending` with a Retry Revoke path. Reconnect is suppressed until that same grant completes cleanup; the row remains visible on reload rather than implying a new grant can replace it.
- Account rows load from the tenant-scoped account API. Connect and reconnect use provider-specific secure OAuth redirects for X, YouTube, and Meta; successful callbacks return to the protected workspace. One Meta group renders separate `Instagram · identity` and `Facebook · Page` destinations. `reauth_required`, `permission_lost`, and `remote_missing` destinations remain visible with reconnect guidance and cannot be selected for new schedules. YouTube rows expose an inline destination-defaults form for visibility, Made for Kids, and subscriber notification so routine schedules need only sparse overrides. Saving is explicit, disables during submission, and keeps errors inline. Disconnect remains blocked until referenced active jobs are cancelled, and the API error stays visible as actionable inline feedback.

## Composer

After active-workspace account loading, the composer shows a focused account gate when no active destination exists. The gate links to that workspace's Accounts route and hides all post controls; loading and fetch-error states remain distinct, with an inline Retry for errors.

An external-draft cockpit link opens the canonical Composer sheet directly. A compact imported-draft status banner names the friendly source label and attached-media count without exposing actor IDs, client IDs, internal storage fields, or raw provenance. All destination, content, timing, validation, success, and failure states remain owned by the existing Composer; there is no separate imported-draft editor.
The same attachment list identifies each imported item's media type, size, and verified video duration when available. Its `Remove from post` action changes only this Composer selection; it never deletes the source draft or retained media. An incompatible or metadata-missing TikTok item remains visibly invalid with a remove/replace path, and choosing a new MP4 replaces active imported selection without erasing the source draft.
When a selected destination cannot use retained imported media (including LinkedIn text or a Facebook link), keep the attachment visible, disable scheduling, and show an inline remove-or-change-destination explanation. Switching accounts must never silently carry an incompatible imported attachment into a post request.

The composer is a 640px right sheet on desktop, full-screen on mobile, and may expand to 880px for preview.
For the selected X destination, the Composer body counter uses the server's `twitter-text` weighted rule. It shows 25,000 only when that X account self-declared long posts; otherwise it shows 280. The textarea does not apply UTF-16 `maxLength` to X content; inline validation blocks over-limit submission and the hint states that self-declared access is unverified and X may reject longer posts.
Its X, Escape, and backdrop-only dismissal all use the same cleanup-aware close path; inside-sheet clicks do not dismiss, saving prevents dismissal, and focus returns to the Create post trigger.

Order:

1. One destination account selected from highlighted single-select cards. No account is preselected. The canonical picker groups rows under highlighted platform headers and names the platform on every row and in the selected `Posting to` summary, so same-name accounts on different platforms cannot be mistaken for one another. Platform labels come from the shared posting adapter registry. Until selection, content and timing controls remain hidden; the chosen account collapses to a compact summary with Change account. Selection moves keyboard focus to Change account; reopening focuses the selected card. Inactive, expired, and unavailable accounts remain visible but disabled with reconnect guidance. The picker describes supported content in human terms, omitting raw capability-freshness values such as `unknown`. The same picker owns all provider families, including TikTok.
2. Post body with target-specific capability/character feedback.
3. Media previews, progress, constraints, removal, and errors.
   The shared media control accepts one MP4 for a single YouTube destination, or up to four X images / one X GIF or MP4 for X-only destinations. It shows attached filenames and removal, validates type/count/size before upload, and uses the existing browser media lifecycle during schedule submission.
   If scheduling returns an uncertain server/network result, the Composer displays a recovery status, makes the content/destination/media/timing controls inert, and changes the primary action to “Confirm previous request.” The sheet cannot be closed or saved as a draft until the unchanged request resolves, preventing a visually replaced file from being submitted against an older upload receipt.
4. Now/Schedule segmented control.
5. Date-time picker with visible timezone.
6. Per-provider preview and validation.
7. Publish now or Schedule 1 post.

The web Composer submits exactly one provider-account ID; the backend multi-destination API remains available to other clients. Offer 15-minute time suggestions while accepting minute precision. Block past times inline. Success becomes a compact receipt with job count, time, and Queue/Calendar links.

The composer schedule uses separate labeled native Date and Time controls with explicit picker buttons, minute precision, and a visible timezone. At 390px the controls stack. They still resolve through the existing local-time/DST choice and ISO submission contract; no scheduling presets are implied.
Meta uses the canonical Composer destination picker and content-shape picker. The destination is
chosen before content: Instagram offers single image and carousel; Facebook offers link and single
image. The picker displays capability freshness and
keeps unavailable destinations visible but disabled. Image upload reuses the canonical hidden file
control/dropzone lifecycle; validation remains inline on desktop and mobile.
Both current Meta image destinations accept JPEG or PNG only. The Composer applies that same
allowlist to retained draft attachments, the file chooser, and newly selected files; unsupported
GIF/WebP attachments stay visible with a remove-or-change-destination path and cannot be scheduled.

## TikTok Direct Post composer

This extends the canonical Composer for the operator-approved destination-first TikTok video flow; it does not create a separate sheet or change X, YouTube, or Meta behavior. The exact Builder/Oracle acceptance matrix is recorded in Publish Relay ticket #13414 note #61404.

1. **Destination gate.** The first visible decision is a single connected TikTok account row in the visual account picker, with TikTok mark, current nickname, handle/avatar where available, and connection health. No destination is preselected, even if it is the only connected account. Selecting any provider replaces the prior account; the Composer is single-destination for every provider. Inactive/revoked/expired TikTok rows stay visible but disabled with `Reconnect` linking to the active workspace Accounts route. After account selection, load fresh creator capabilities; show a geometry-matched in-sheet loading state and keep consent/submit unavailable until success. The displayed nickname must come from that returned snapshot, not a stale account-row label. If nickname differs, show `Posting as <fresh nickname>`; the account ID remains internal.
2. **Video-first composition.** Only `Video` is offered for TikTok; no text-only/photo/carousel affordance and no media-first provider detection. Show one MP4 picker using the existing upload/attachment lifecycle plus an actual playable poster/preview of the chosen video (or an explicit `Preview unavailable` state while still identifying the exact file). Label caption with TikTok's 2,200 UTF-16-rune limit from the backend contract, not the X 280 counter. Show filename, duration versus fetched account maximum, format/size constraints, upload progress and inline failure/removal. Imported drafts reuse the same banner and canonical media IDs; an incompatible draft reports why it cannot continue and offers a recoverable action, never silently drops media. Video preview, nickname, destination and timezone remain visible or immediately reachable in the final confirmation area.
3. **Returned capabilities and controls.** Label `Who can view this video` with the server-returned privacy options only. Initial value is a placeholder `Choose visibility`; no first-option, channel-default, or implicit `SELF_ONLY` selection. Render Comment, Duet and Stitch as three separately labeled toggles, initially off. When the capability flag disables one, keep it off/disabled and explain `Unavailable for this account` in text. Do not silently flip a selected option on refresh. Show fetched time/freshness in human language and a `Refresh TikTok options` action. `DefaultsSelect` must expose the selected privacy in keyboard and screen-reader state.
4. **Commercial, music and AI declarations.** Mirror TikTok's per-video controls: `Commercial content` starts off. When enabled, show separate `Your brand` and `Branded content` checkboxes; require at least one, and allow both. `Your brand` previews the provider's `Promotional content` label; branded or both previews `Paid partnership`. If `Branded content` is selected, only creator-returned public or friends visibility is eligible; private is invalid, and if the unaudited client exposes only private visibility the branded choice cannot proceed. Never silently change the selected privacy. Show the applicable TikTok-linked Music Usage Confirmation and, for branded content, Branded Content Policy declarations with their current provider wording and links; require explicit unchecked-by-default confirmation before publishing. Keep both links in the declaration and use the provider's `By posting, you agree to TikTok's …` wording. Do not invent legal copy. Ask `Is this video AI-generated?` with explicit Yes/No (no default); upstream CreatorForge involvement alone does not decide the answer. Persist the per-video choices exactly and send the matching provider settings. Unchecked declarations or unanswered AI choice keep confirmation disabled with field-level explanation.
5. **Review and exact consent.** Keep existing Now/Schedule and visible timezone/DST resolution. Before final action, present a compact review within the same sheet: TikTok nickname, video thumbnail/name/duration, caption, visibility, enabled interactions, the selected Your brand/Branded content flags, AI Yes/No, declaration checks and exact scheduled local time plus timezone (or Publish now). Use one primary `Confirm and schedule` / `Confirm and publish` action whose click issues server consent for the exact persisted revision and then schedules that same revision through the approved application service. A receipt is not a browser boolean. No second dispatch-time prompt. Put `TikTok may take several minutes to process this video` near the action and in the success receipt; receipt links to Queue/Calendar. Queue/detail later show processing, failure/needs-attention and eventual provider link from server truth, not a success assertion at initialization.
6. **Invalidation and recovery.** Editing caption, video/media, account, privacy, interactions, either commercial checkbox, AI choice, cover (if later exposed), or schedule after review invalidates the prior consent receipt. Reset to a review-needed state and require a new confirmation; never reuse stale receipt. Capability snapshot expiry, query error, mismatch after token rotation/reconnect, revoked/rotated account, or media metadata failure leaves the form visible but final action blocked. Use a persistent inline alert and `Refresh TikTok options` or `Reconnect account` as appropriate; preserve harmless form data where safe but do not restore any old consent. If fresh options no longer include the selected privacy or interaction, visibly mark the conflict and demand an explicit new choice; do not downgrade. A backend `needs_attention` after dispatch remains a Queue/detail recovery state with reason and action, not an auto-retry. Existing uncertain-request guard freezes all mutation and keeps the same idempotency key/media identity until resolved.
7. **API/CLI handoff.** Machine clients may create/update a TikTok draft and receive the canonical workspace-bound `/w/:workspace/drafts/:draftId` browser cockpit URL. Opening it lands in this Composer with imported-media banner, TikTok destination still explicitly chosen, and human session authentication. API/CLI scheduling cannot bypass a valid server-issued exact-revision consent receipt. A stale/used/wrong-account receipt returns actionable failure and browser re-consent link; never silently post or ask the API client to forge checkboxes.
8. **Accessibility/responsive/motion.** Desktop retains 640px sheet, expands to at most 880px for video preview; mobile is full-screen and scrolls content with sticky action footer above safe area. At 390px all controls and the preview fit without horizontal scroll; target hit areas >=44px. Fieldsets/legends group privacy, interactions and declarations. Status is text + icon + color; errors are persistent `role=alert`, successful receipt is polite live status. Focus enters heading/first account on open, follows validation to first invalid field, and returns to Create post on close. Escape/backdrop uses existing cleanup path. Do not autoplay video or move focus during async refresh. Reuse 100/160/220/280ms motion tokens; reduced-motion removes sheet transform and preview/receipt animation, with any opacity under 100ms. No decorative TikTok-branded gradients, emoji or confetti.

Implementation anchors: `workflow.tsx` retains the one Composer sheet, media picker/upload lifecycle, and final action; `tiktok-composer.tsx` owns only TikTok's capability-bound form and review, keyed by selected account so account switching cannot carry declarations across subjects. `tiktok-submit.ts` owns the browser-side exact-revision request sequence and retry identity. `.composer-sheet-tiktok`, `.tiktok-options-group`, `.tiktok-video-preview`, and `.tiktok-review` extend the existing sheet tokens, not a second shell. The form exposes a validated exact-choice snapshot to the sheet; only a ready snapshot enables `Confirm and schedule` / `Confirm and publish`. The action uploads one MP4 through the shared media lifecycle, prepares the exact revision, requests human consent, and schedules that same revision. After any uncertain stage, the sheet freezes choices and retries the same request identities; a receipt appears only after server-confirmed scheduling and includes the processing caveat.

E5 picker admission: `posting-adapter-registry.ts` remains the single Add Posting Adapter list for onboarding and Accounts. It exposes TikTok only when the server shell marks its reviewed runtime enabled; there is no dead selectable OAuth choice under incomplete configuration. Connected TikTok rows remain visible for recovery, but Composer renders them disabled with `Connected · publishing is not yet available` when runtime is absent. With runtime enabled, selection fetches creator options in `TikTokComposerForm`; loading, error, stale or invalid options never imply a publishable destination. The same Composer account-picker markup is used for every provider; no second TikTok picker is introduced.

Prepared TikTok recovery stays inside the canonical Composer after explicit destination selection. The bounded prepared-post list uses secondary Resume and Load more actions with safe caption/date labels; detail restores only caption and the referenced MP4, never an account or old consent. A secondary Start a new TikTok post action clears local selection without deleting the server-owned prepared post. Current capability options and declarations must be chosen again. Deterministic server rejection may return to this editable state only after the prepared post is re-read; an ambiguous mutation keeps the existing frozen same-key confirmation path. Revised content/media uses the canonical immutable revision endpoint before fresh exact-revision consent, while an unchanged revision preserves its identity. The recovery list is not a second Composer shell.

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

### Calendar account and status filters

The account-count and status labels are functional buttons. Each opens a compact checkbox popover anchored immediately below its trigger, never a centered dialog. Reuse the Queue filter trigger's visual language, but keep Queue's single-select `FilterSelect` semantics separate. One shared checkbox-popover primitive serves both Calendar controls. The menu must escape Calendar clipping/stacking ancestors, flip at viewport edges, fit at 390px mobile width, and preserve 44px touch targets.

Implementation ownership: `CalendarCheckboxFilter` in `src/ui/calendar-filters.tsx` owns the shared body-portaled account/status checkbox menu and its collision-aware placement. `CalendarPage` in `src/ui/workflow.tsx` owns authorized paginated account-catalog loading, normalized status/account URL selections, post-merge filtering, and the result count. `.calendar-filter-*` classes in `src/ui/styles.css` style only this multi-select surface; Queue retains its separate single-select `FilterSelect`.

The account popover lists every account authorized for the Calendar, including exposed shared Pages, with provider, display name and handle when available. Use stable provider-account IDs, not names or handles, as selection keys. The default selects all; the trigger shows the total account count or `N of M accounts` when narrowed. The catalog and count must not depend on jobs in the current date window or a truncated page. An unexposed Page must never appear. The status popover defaults to `All statuses` and offers the existing normalized Calendar states with their human labels, including Scheduled, Published, Failed, Retry/Needs attention and provider processing. Selecting multiple statuses shows `N statuses`.

Group account rows under the same provider headings and ordering used by Create Post; headings are separators, never selection keys. Every account, including multiple accounts under one provider, remains independently selectable. Show a compact filtered-results count beside the controls on desktop and an accessible summary on mobile; update its polite announcement only after user filter changes, not each background refresh. Account-menu search and a Needs attention preset are not part of this approved pass.

Changes filter the visible Calendar immediately, without an Apply button or any publication/account write. Account and status selections combine with AND, after target/shared-mirror merge and deduplication but before Month/Week/Day/Timeline layout and `+N more` counts. Keep both selections through date/view navigation, refresh, copied URL and browser back/forward; omit default filters from the URL and reset on workspace switch. Unknown/stale URL selections must show a non-blocking notice and reset action, not silently broaden a narrowed view. `Select all` restores a control's default; `Clear filters` restores both. Zero selected values deliberately show no posts with a one-click recovery. Distinguish no matching jobs from an actually empty schedule, loading, and fetch failure. Filtering must not change shared-Page origin badges, status truth, timezone placement or detail links.

Use native button/checkbox semantics: accurate expanded state and accessible summaries, Enter/Space to open/toggle, Tab through rows, Escape to close and restore trigger focus, outside click to dismiss without stealing the clicked target's focus. Opening one popover closes the other. Keep visible focus, bounded internal menu scrolling, reduced-motion behavior and no horizontal body scroll. Verify desktop/mobile, keyboard and screen-reader behavior across all four Calendar modes; Queue's existing single-select filters must remain unchanged.

- Month shows up to three jobs then `+N more`; failures sort first within a day.
- Week/day uses a 24-hour grid, current-time line, and positioned job blocks.
- Timeline uses account lanes and 15-minute snapping.
- Dragging previews a new time and requires confirmation before persistence.
- Reschedule in job detail is the keyboard alternative.
- Overlaps stack visibly with account identity.
- Mobile defaults to agenda/day; month opens the selected day below.

## Job detail and recovery

An unresolved Snapchat Story send uses the shared Queue and detail status renderer with `Needs attention`, appears in the existing Needs attention view rather than Upcoming, and shows a persistent no-blind-retry explanation in the existing recovery panel. The provider request reference is available only under Technical details; it is correlation, not a Story link or published state. Retry controls stay absent while outcome is unknown. This fixture-only presentation does not enable customer Story admission or manual resolution.

Failure-only Story evidence resolution extends that same job-detail recovery panel, not a second job view. Owner/admin sessions may choose a friendly Snapchat evidence source, a verified rejection/absence finding, and a provider evidence reference, then confirm in the shared dialog before the server records a failed outcome. Non-admin sessions see only the unresolved explanation; the route independently enforces workspace authority. Refresh detail from server truth after mutation so status, timeline and no external link agree. No user-entered Story URL or published resolution is offered without an authoritative request-to-Story correlation contract.

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
- Settings Automation loads the eligible API-key permissions from the server and presents all of them selected for new keys; each can be turned off, but at least one is required. An active key row reuses the capability button group for Edit permissions with Save/Cancel, preserves the one-time secret boundary, and refreshes the row after save or stale-version conflict. Revoked keys have no edit action. The `.api-key-permission-editor` and `.api-key-actions` classes extend the existing row/secondary-button pattern.
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

LinkedIn member video reuses the destination-first Composer sheet and its existing media attachment/upload/remove lifecycle. Choosing the Video content kind presents one MP4 picker and a required friendly video title beside the normal post body; text and article keep their media-free shapes. Processing is represented by the existing Queue/detail job state rather than a new Composer shell. `.linkedin-video-title` is the semantic anchor for the title field; upload rejection and cleanup use the shared inline error and media controls.

- The canonical publication composer in `src/ui/workflow.tsx` switches to a single-channel YouTube video flow only when exactly one YouTube destination is selected.
- Successful YouTube receipts render an allowlisted definition list with friendly visibility, Made for Kids, and subscriber-notification labels; internal settings keys and raw JSON never appear.
- It uploads one MP4 through the authenticated browser media endpoint before creating the post, exposes sparse per-publication overrides, and displays the returned effective settings snapshot in the receipt.
