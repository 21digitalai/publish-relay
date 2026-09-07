ALTER TABLE "media_objects" ALTER COLUMN "byte_size" SET DATA TYPE bigint;
ALTER TABLE "media_objects" ADD COLUMN "duration_ms" integer;
ALTER TABLE "media_objects" ADD COLUMN "width" integer;
ALTER TABLE "media_objects" ADD COLUMN "height" integer;
ALTER TABLE "media_objects" ADD COLUMN "video_codec" text;
ALTER TABLE "media_objects" ADD COLUMN "audio_codec" text;
ALTER TABLE "media_objects" ADD COLUMN "container" text;

ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_video_metadata_check" CHECK (
  (mime_type <> 'video/mp4' AND duration_ms IS NULL AND width IS NULL AND height IS NULL AND video_codec IS NULL AND audio_codec IS NULL AND container IS NULL)
  OR
  (mime_type = 'video/mp4' AND duration_ms > 0 AND width > 0 AND height > 0 AND video_codec IS NOT NULL AND container = 'mp4')
);
