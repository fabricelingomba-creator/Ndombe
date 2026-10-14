-- Notifications push vers l'app mobile.
--
--   push_devices : jeton Expo Push de chaque téléphone connecté (un compte peut en avoir plusieurs).
--   Le canal « push » rejoint l'e-mail dans la file notification_deliveries et dans les préférences.

CREATE TABLE push_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  token         text NOT NULL CHECK (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$'),
  platform      text NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  -- Un téléphone qui change de compte passe au nouveau compte.
  UNIQUE (tenant_id, token)
);
CREATE INDEX push_devices_user_idx ON push_devices (tenant_id, user_id);

ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_devices
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('email', 'push'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_channel_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_channel_check CHECK (channel IN ('email', 'push'));

GRANT SELECT, INSERT, UPDATE, DELETE ON push_devices TO elongo_app, elongo_platform;
