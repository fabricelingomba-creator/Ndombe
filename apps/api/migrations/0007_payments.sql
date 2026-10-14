-- Phase 2 : frais de scolarité et paiements.
--
--   tenant_payment_providers : prestataires activés par l'université, avec
--                              leurs secrets chiffrés (AES-256-GCM, clé hors base).
--   fee_structures           : un frais (inscription, minerval…) et son montant.
--   invoices                 : la facture d'un étudiant pour un frais.
--   payments                 : une tentative de paiement chez un prestataire.
--   payment_events           : chaque notification (webhook) reçue, une seule
--                              fois par identifiant d'événement.
--
-- Les montants sont en unités mineures (centimes) pour éviter les arrondis.

CREATE TABLE tenant_payment_providers (
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('sandbox')),
  enabled             boolean NOT NULL DEFAULT true,
  secrets_ciphertext  text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE fee_structures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code          text NOT NULL CHECK (length(code) BETWEEN 1 AND 32),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  currency      text NOT NULL CHECK (currency IN ('CDF', 'USD')),
  term_id       uuid,
  due_on        date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, term_id) REFERENCES academic_terms (tenant_id, id)
);

CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  fee_structure_id  uuid NOT NULL,
  student_user_id   uuid NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  currency          text NOT NULL CHECK (currency IN ('CDF', 'USD')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  due_on            date NOT NULL,
  paid_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fee_structure_id, student_user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, fee_structure_id) REFERENCES fee_structures (tenant_id, id),
  FOREIGN KEY (tenant_id, student_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX invoices_student_idx ON invoices (student_user_id, created_at DESC);
CREATE INDEX invoices_status_idx ON invoices (tenant_id, status);

CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_id       uuid NOT NULL,
  student_user_id  uuid NOT NULL,
  provider         text NOT NULL CHECK (provider IN ('sandbox')),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  currency         text NOT NULL CHECK (currency IN ('CDF', 'USD')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  -- Clé fournie par le client : rejouer la même requête ne crée pas un second paiement.
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  provider_ref     text,
  -- Page de paiement du prestataire (s'il en a une), renvoyée telle quelle si la requête est rejouée.
  redirect_url     text,
  phone            text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (provider, provider_ref),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, student_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

-- Un paiement abouti ou échoué est définitif.
CREATE OR REPLACE FUNCTION app.forbid_final_payment_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'paiement définitif (%)', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency OR NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'montant et facture d''un paiement non modifiables' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_final
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.forbid_final_payment_change();

CREATE TABLE payment_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  payment_id   uuid,
  outcome      text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, event_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_payment_providers', 'fee_structures', 'invoices', 'payments', 'payment_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON tenant_payment_providers, fee_structures, invoices, payments TO elongo_app, elongo_platform;
GRANT SELECT, INSERT ON payment_events TO elongo_app, elongo_platform;
GRANT USAGE ON SEQUENCE payment_events_id_seq TO elongo_app, elongo_platform;
