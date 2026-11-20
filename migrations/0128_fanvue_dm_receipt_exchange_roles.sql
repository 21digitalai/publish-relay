ALTER TABLE fanvue_dm_message_receipts
  ADD COLUMN exchange_role text;

UPDATE fanvue_dm_message_receipts
SET exchange_role = CASE
  WHEN direction = 'inbound' THEN 'inbound_turn'
  ELSE 'automation'
END;

ALTER TABLE fanvue_dm_message_receipts
  ALTER COLUMN exchange_role SET NOT NULL,
  ADD CONSTRAINT fanvue_dm_message_receipts_exchange_role_check CHECK (
    (direction = 'inbound' AND exchange_role = 'inbound_turn')
    OR (direction = 'outbound' AND exchange_role IN ('outbound_root', 'outbound_tail', 'automation'))
  );
