ALTER TABLE fanvue_dm_message_receipts
  ADD COLUMN exchange_role text;

UPDATE fanvue_dm_message_receipts
SET exchange_role = CASE
  WHEN direction = 'inbound' THEN 'inbound_turn'
  ELSE 'outbound_root'
END;

ALTER TABLE fanvue_dm_message_receipts
  ALTER COLUMN exchange_role SET NOT NULL,
  ADD CONSTRAINT fanvue_dm_message_receipts_exchange_role_check CHECK (
    exchange_role IN ('inbound_turn', 'outbound_root', 'outbound_tail', 'automation')
  );
