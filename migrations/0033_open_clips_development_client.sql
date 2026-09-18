INSERT INTO "registered_clients" ("id", "display_name", "client_type", "redirect_uris", "allowed_scopes")
VALUES (
  'open-clips-dev',
  'Open Clips (development)',
  'public',
  ARRAY['http://127.0.0.1:43123/callback'],
  ARRAY['destinations:read', 'schedules:read', 'schedules:write', 'content:write', 'publishes:retry']
)
ON CONFLICT ("id") DO UPDATE SET
  "display_name" = EXCLUDED."display_name",
  "client_type" = EXCLUDED."client_type",
  "redirect_uris" = EXCLUDED."redirect_uris",
  "allowed_scopes" = EXCLUDED."allowed_scopes";
