import { useEffect, useState } from 'react';

import { DefaultsSelect } from './defaults-select.js';
import {
  brandedVisibilityAllowed,
  commercialContentFromFlags,
  TIKTOK_CAPTION_MAX_LENGTH,
} from '../modules/providers/tiktok-publication-options.js';

interface CapabilitySnapshot {
  id: string;
  nickname: string;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoDurationSeconds: number;
  fetchedAt: string;
  expiresAt: string;
}

const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

export interface ImportedDraftMedia {
  id: string;
  mimeType: string | null;
  byteSize: number | null;
  durationMs: number | null;
  ready: boolean;
  previewUrl: string | null;
}

export function TikTokComposerForm({
  accountId,
  caption,
  onCaptionChange,
  video,
  importedMedia,
  scheduled,
  scheduledAt,
}: {
  accountId: string;
  caption: string;
  onCaptionChange: (value: string) => void;
  video: File | null;
  importedMedia: ImportedDraftMedia[];
  scheduled: boolean;
  scheduledAt: Date | undefined;
}) {
  const [capability, setCapability] = useState<CapabilitySnapshot | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [privacy, setPrivacy] = useState('');
  const [comment, setComment] = useState(false);
  const [duet, setDuet] = useState(false);
  const [stitch, setStitch] = useState(false);
  const [commercialEnabled, setCommercialEnabled] = useState(false);
  const [ownBrand, setOwnBrand] = useState(false);
  const [branded, setBranded] = useState(false);
  const [musicConfirmed, setMusicConfirmed] = useState(false);
  const [brandedConfirmed, setBrandedConfirmed] = useState(false);
  const [aiGenerated, setAiGenerated] = useState<'yes' | 'no' | ''>('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState('loading');
    setLoadError(null);
    setCapability(null);
    void fetch(`/api/provider-accounts/${accountId}/tiktok-capabilities`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        const result = (await response.json()) as {
          data?: CapabilitySnapshot;
          error?: string | null;
        };
        if (!response.ok || !result.data)
          throw new Error(result.error ?? 'TikTok options could not be loaded.');
        setCapability(result.data);
        setLoadState('ready');
        setNow(Date.now());
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(reason instanceof Error ? reason.message : 'TikTok options are unavailable.');
        setLoadState('error');
      });
    return () => {
      controller.abort();
    };
  }, [accountId, refresh]);

  useEffect(() => {
    if (!video) {
      setPreviewUrl(null);
      setDuration(null);
      setPreviewError(false);
      return;
    }
    const url = URL.createObjectURL(video);
    setPreviewUrl(url);
    setDuration(null);
    setPreviewError(false);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [video]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const expired = Boolean(capability && Date.parse(capability.expiresAt) <= now);
  const privacyMissing = Boolean(
    capability && privacy && !capability.privacyOptions.includes(privacy),
  );
  const interactionConflict = Boolean(
    capability &&
    ((comment && capability.commentDisabled) ||
      (duet && capability.duetDisabled) ||
      (stitch && capability.stitchDisabled)),
  );
  const commercial = commercialEnabled ? commercialContentFromFlags(ownBrand, branded) : 'none';
  const brandedVisibilityConflict = branded && privacy !== '' && !brandedVisibilityAllowed(privacy);
  const brandedUnavailable = Boolean(
    capability && !capability.privacyOptions.some(brandedVisibilityAllowed),
  );
  const captionTooLong = caption.length > TIKTOK_CAPTION_MAX_LENGTH;
  const importedVideo = !video && importedMedia.length === 1 ? importedMedia[0] : null;
  const importedVideoReady = Boolean(
    importedVideo?.ready &&
    importedVideo.mimeType === 'video/mp4' &&
    importedVideo.durationMs !== null &&
    importedVideo.previewUrl,
  );
  const effectiveDuration = video
    ? duration
    : importedVideoReady && importedVideo && importedVideo.durationMs !== null
      ? importedVideo.durationMs / 1000
      : null;
  const videoTooLong = Boolean(
    effectiveDuration !== null &&
    capability &&
    effectiveDuration > capability.maxVideoDurationSeconds,
  );
  const videoLabel =
    video?.name ?? (importedVideoReady ? 'Imported MP4 video' : 'No video selected');

  return (
    <div className="tiktok-composer-options">
      <p className="composer-provider-notice">TikTok Direct Post · one account and one MP4 video</p>
      {loadState === 'loading' && <p role="status">Loading current TikTok options…</p>}
      {loadState === 'error' && (
        <p className="inline-validation" role="alert">
          {loadError}
        </p>
      )}
      {capability && (
        <p role="status">
          Posting as <strong>{capability.nickname}</strong> · Options checked{' '}
          {new Date(capability.fetchedAt).toLocaleTimeString()}
        </p>
      )}
      <button
        className="secondary-button"
        type="button"
        onClick={() => {
          setRefresh((n) => n + 1);
        }}
      >
        Refresh TikTok options
      </button>
      {expired && (
        <p className="inline-validation" role="alert">
          TikTok options expired. Refresh before continuing.
        </p>
      )}
      <label className="field-label">
        Caption
        <textarea
          className="composer-body"
          value={caption}
          onChange={(event) => {
            onCaptionChange(event.target.value);
          }}
          placeholder="Describe this video"
          maxLength={TIKTOK_CAPTION_MAX_LENGTH}
        />
        <small>
          {caption.length} / {TIKTOK_CAPTION_MAX_LENGTH} characters
        </small>
      </label>
      {captionTooLong && (
        <p className="inline-validation" role="alert">
          TikTok captions cannot exceed 2200 characters.
        </p>
      )}
      <div className="tiktok-video-preview">
        <strong>{videoLabel}</strong>
        <p>MP4 · maximum 2 GB Core upload size; account duration limit shown below.</p>
        {previewUrl || importedVideoReady ? (
          <video
            controls
            playsInline
            preload="metadata"
            src={previewUrl ?? importedVideo?.previewUrl ?? undefined}
            onLoadedMetadata={(event) => {
              setDuration(event.currentTarget.duration);
            }}
            onError={() => {
              setPreviewError(true);
            }}
            aria-label={`Preview ${videoLabel}`}
          />
        ) : (
          <p>
            Preview unavailable
            {' until a valid video is selected'}.
          </p>
        )}
        {capability && (
          <p>
            {effectiveDuration === null
              ? 'Duration not available'
              : `${String(Math.ceil(effectiveDuration))} seconds`}{' '}
            · Maximum {capability.maxVideoDurationSeconds} seconds for this account
          </p>
        )}
        {videoTooLong && (
          <p className="inline-validation" role="alert">
            This video exceeds the current account duration limit.
          </p>
        )}
        {previewError && (
          <p className="inline-validation" role="alert">
            This video preview or metadata could not be loaded. Choose a valid MP4 before
            scheduling.
          </p>
        )}
        {importedMedia.length > 1 && (
          <p className="inline-validation" role="alert">
            This draft has multiple media items; TikTok accepts one video. Remove extra items below
            or choose a replacement MP4.
          </p>
        )}
        {importedVideo && !importedVideoReady && (
          <p className="inline-validation" role="alert">
            {!importedVideo.mimeType
              ? 'The imported media type is unavailable.'
              : importedVideo.mimeType !== 'video/mp4'
                ? 'The imported item is not an MP4 video.'
                : !importedVideo.ready
                  ? 'The imported video is no longer available.'
                  : 'The imported video has no verified duration or preview.'}{' '}
            Remove it below or choose a replacement MP4.
          </p>
        )}
      </div>
      {capability && (
        <fieldset className="tiktok-options-group">
          <legend>Who can view this video</legend>
          <DefaultsSelect
            label="Visibility"
            name="tiktok-privacy"
            value={privacy}
            options={[
              ['', 'Choose visibility'],
              ...capability.privacyOptions.map((option): [string, string] => [
                option,
                PRIVACY_LABELS[option] ?? option,
              ]),
            ]}
            onChange={setPrivacy}
          />
          {!privacy && <p className="inline-validation">Choose visibility explicitly.</p>}
          {privacyMissing && (
            <p className="inline-validation" role="alert">
              This visibility is no longer available. Choose a returned option.
            </p>
          )}
        </fieldset>
      )}
      <fieldset className="tiktok-options-group">
        <legend>Interactions</legend>
        {(
          [
            ['Comment', comment, setComment, capability?.commentDisabled],
            ['Duet', duet, setDuet, capability?.duetDisabled],
            ['Stitch', stitch, setStitch, capability?.stitchDisabled],
          ] as const
        ).map(([label, value, setter, disabled]) => (
          <label className="tiktok-choice" key={label}>
            <input
              type="checkbox"
              checked={value}
              disabled={!capability || disabled}
              onChange={(event) => {
                setter(event.target.checked);
              }}
            />
            {label}
            {disabled ? ' · Unavailable for this account' : ''}
          </label>
        ))}
        {interactionConflict && (
          <p className="inline-validation" role="alert">
            An enabled interaction is no longer available. Turn it off to continue.
          </p>
        )}
      </fieldset>
      <fieldset className="tiktok-options-group">
        <legend>Commercial content</legend>
        <label className="tiktok-choice">
          <input
            type="checkbox"
            checked={commercialEnabled}
            onChange={(event) => {
              setCommercialEnabled(event.target.checked);
              if (!event.target.checked) {
                setOwnBrand(false);
                setBranded(false);
                setBrandedConfirmed(false);
              }
            }}
          />
          Commercial content
        </label>
        {commercialEnabled && (
          <>
            <p>Does this video promote yourself, a brand, product, or service?</p>
            <label className="tiktok-choice">
              <input
                type="checkbox"
                checked={ownBrand}
                onChange={(event) => {
                  setOwnBrand(event.target.checked);
                }}
              />
              Your brand · promotes you or your business
            </label>
            <label className="tiktok-choice">
              <input
                type="checkbox"
                checked={branded}
                disabled={brandedUnavailable && !branded}
                onChange={(event) => {
                  setBranded(event.target.checked);
                  if (!event.target.checked) setBrandedConfirmed(false);
                }}
              />
              Branded content · promotes another brand or third party
            </label>
            {commercial === 'none' && (
              <p className="inline-validation" role="alert">
                Choose Your brand, Branded content, or both.
              </p>
            )}
            {brandedUnavailable && (
              <p className="inline-validation" role="alert">
                Branded content is unavailable while this account offers only private visibility.
              </p>
            )}
            {commercial !== 'none' && (
              <p>
                Your video will be labeled as {branded ? 'Paid partnership' : 'Promotional content'}
                .
              </p>
            )}
          </>
        )}
        {brandedVisibilityConflict && (
          <p className="inline-validation" role="alert">
            Branded content cannot use private visibility. Choose an available Everyone or Friends
            option; we will not change visibility automatically.
          </p>
        )}
        <label className="tiktok-choice">
          <input
            type="checkbox"
            checked={musicConfirmed}
            onChange={(event) => {
              setMusicConfirmed(event.target.checked);
            }}
          />
          I confirm Music Usage Confirmation
        </label>
        {branded && (
          <label className="tiktok-choice">
            <input
              type="checkbox"
              checked={brandedConfirmed}
              onChange={(event) => {
                setBrandedConfirmed(event.target.checked);
              }}
            />
            I confirm Branded Content Policy
          </label>
        )}
        <p>
          By posting, you agree to TikTok's{' '}
          {branded && (
            <>
              <a
                href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                target="_blank"
                rel="noopener noreferrer"
              >
                Branded Content Policy
              </a>{' '}
              and{' '}
            </>
          )}
          <a
            href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
            target="_blank"
            rel="noopener noreferrer"
          >
            Music Usage Confirmation
          </a>
          .
        </p>
      </fieldset>
      <fieldset className="tiktok-options-group">
        <legend>Is this video AI-generated?</legend>
        <p>
          CreatorForge involvement alone does not decide this. Choose based on the actual video.
        </p>
        {(['yes', 'no'] as const).map((value) => (
          <label className="tiktok-choice" key={value}>
            <input
              type="radio"
              name="tiktok-ai"
              checked={aiGenerated === value}
              onChange={() => {
                setAiGenerated(value);
              }}
            />
            {value === 'yes' ? 'Yes' : 'No'}
          </label>
        ))}
        {!aiGenerated && <p className="inline-validation">Choose Yes or No explicitly.</p>}
      </fieldset>
      <section className="tiktok-review" aria-label="Review TikTok publication">
        <h3>Review before confirming</h3>
        <p>Account: {capability?.nickname ?? 'Waiting for current account options'}</p>
        <p>
          Video: {videoLabel}
          {effectiveDuration !== null ? ` · ${String(Math.ceil(effectiveDuration))} seconds` : ''}
        </p>
        <p>Caption: {caption || 'Not entered'}</p>
        <p>Visibility: {privacy ? (PRIVACY_LABELS[privacy] ?? privacy) : 'Not chosen'}</p>
        <p>
          Interactions:{' '}
          {[comment && 'Comment', duet && 'Duet', stitch && 'Stitch'].filter(Boolean).join(', ') ||
            'Off'}
        </p>
        <p>
          Commercial:{' '}
          {commercialEnabled
            ? `${ownBrand ? 'Your brand' : ''}${ownBrand && branded ? ' + ' : ''}${branded ? 'Branded content' : ''}` ||
              'Choose disclosure'
            : 'Off'}{' '}
          · AI-generated: {aiGenerated || 'Not answered'}
        </p>
        <p>
          Declarations: music {musicConfirmed ? 'checked' : 'unchecked'}
          {branded ? ` · branded policy ${brandedConfirmed ? 'checked' : 'unchecked'}` : ''}
        </p>
        <p>
          {scheduled ? (scheduledAt?.toLocaleString() ?? 'Choose a time') : 'Publish now'} ·{' '}
          {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </p>
      </section>
      <p className="composer-provider-notice">
        TikTok may take several minutes to process a video after scheduling. Scheduling is not yet
        available in this integration slice.
      </p>
    </div>
  );
}
