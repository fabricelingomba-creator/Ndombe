-- Centre de notifications.
--
--   notifications           : boîte de réception de chaque utilisateur (dans l'application).
--   notification_deliveries : file d'envoi vers les canaux externes (e-mail pour l'instant),
--                             écrite dans la même transaction que l'événement, envoyée ensuite.
--   notification_preferences: canaux refusés par l'utilisateur, par catégorie (tout est actif par défaut).

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind ~ '^[a-z_]+(\.[a-z_]+)+$'),
  category    text NOT NULL CHECK (category IN ('finance', 'academic', 'tasks', 'announcements')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body        text NOT NULL CHECK (length(body) <= 2000),
  -- Chemin interne au portail (jamais une URL externe).
  link        text CHECK (link ~ '^/[A-Za-z0-9/_?=&.-]*$' AND link !~ '^//'),
  -- Empêche d'envoyer deux fois le même rappel.
  dedup_key   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, dedup_key)
);
CREATE INDEX notifications_inbox_idx ON notifications (tenant_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (tenant_id, user_id) WHERE read_at IS NULL;

CREATE TABLE notification_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  notification_id  uuid NOT NULL,
  channel          text NOT NULL CHECK (channel IN ('email')),
  recipient        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, notification_id) REFERENCES notifications (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (notification_id, channel)
);
CREATE INDEX notification_deliveries_due_idx
  ON notification_deliveries (tenant_id, next_attempt_at) WHERE status = 'pending';

CREATE TABLE notification_preferences (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  category    text NOT NULL CHECK (category IN ('finance', 'academic', 'tasks', 'announcements')),
  channel     text NOT NULL CHECK (channel IN ('email')),
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, category, channel),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- Les annonces sont diffusées une fois publiées (y compris celles programmées).
ALTER TABLE announcements ADD COLUMN notified_at timestamptz;
CREATE INDEX announcements_to_notify_idx ON announcements (tenant_id, published_at) WHERE notified_at IS NULL;

DO $$
DECLARE
  t text;
  tenant uuid;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_deliveries', 'notification_preferences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
  END LOOP;

  -- Les annonces déjà publiées avant cette version ne sont pas rediffusées.
  FOR tenant IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant::text, true);
    UPDATE announcements SET notified_at = now() WHERE notified_at IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

GRANT SELECT, INSERT, UPDATE ON notifications, notification_deliveries, notification_preferences
  TO elongo_app, elongo_platform;
