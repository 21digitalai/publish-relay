ALTER TABLE fanvue_payment_subscriptions
  DROP CONSTRAINT fanvue_payment_subscriptions_state_check;
ALTER TABLE fanvue_payment_subscriptions
  ADD CONSTRAINT fanvue_payment_subscriptions_state_check
    CHECK (state IN ('probe_pending', 'creation_unknown', 'active', 'deletion_required', 'disabled'));
ALTER TABLE fanvue_payment_subscriptions
  ADD CONSTRAINT fanvue_payment_subscriptions_deletion_fields_check
    CHECK (state <> 'deletion_required' OR
      (provider_subscription_id IS NOT NULL AND signing_credential_id IS NULL));
