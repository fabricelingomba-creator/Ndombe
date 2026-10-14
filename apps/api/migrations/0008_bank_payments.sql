-- Paiement par banque : l'étudiant dépose les frais sur un compte de
-- l'université, puis envoie son bordereau ; le service financier le valide
-- (le paiement aboutit et règle la facture) ou le refuse avec un motif.
--
--   bank_accounts : comptes bancaires de l'université, par devise.
--   bank_slips    : bordereau rattaché à un paiement « bank » (fichier, référence,
--                   date de dépôt, décision du service financier).

CREATE TABLE bank_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_name       text NOT NULL CHECK (length(bank_name) BETWEEN 2 AND 100),
  account_name    text NOT NULL CHECK (length(account_name) BETWEEN 2 AND 200),
  account_number  text NOT NULL CHECK (account_number ~ '^[A-Za-z0-9][A-Za-z0-9 -]{3,63}$'),
  currency        text NOT NULL CHECK (currency IN ('CDF', 'USD')),
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_name, account_number),
  UNIQUE (tenant_id, id)
);

ALTER TABLE payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check CHECK (provider IN ('sandbox', 'bank'));

CREATE TABLE bank_slips (
  payment_id       uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  bank_account_id  uuid NOT NULL,
  -- Numéro du bordereau tel qu'imprimé par la banque.
  reference        text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{2,63}$'),
  paid_on          date NOT NULL,
  file             bytea NOT NULL,
  file_type        text NOT NULL CHECK (file_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  file_size        integer NOT NULL CHECK (file_size BETWEEN 1 AND 5242880),
  file_sha256      text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  decision         text CHECK (decision IN ('accepted', 'rejected')),
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users (tenant_id, id),
  CHECK ((decision IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX bank_slips_pending_idx ON bank_slips (tenant_id, created_at) WHERE decision IS NULL;

-- Un même bordereau (référence ou fichier) ne sert qu'une fois, sauf s'il a été refusé.
CREATE UNIQUE INDEX bank_slips_reference_key
  ON bank_slips (tenant_id, bank_account_id, upper(reference)) WHERE decision IS DISTINCT FROM 'rejected';
CREATE UNIQUE INDEX bank_slips_file_key
  ON bank_slips (tenant_id, file_sha256) WHERE decision IS DISTINCT FROM 'rejected';

-- Une décision est définitive.
CREATE OR REPLACE FUNCTION app.forbid_decided_slip_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'bordereau déjà traité (%)', OLD.decision USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.file <> OLD.file OR NEW.reference <> OLD.reference OR NEW.bank_account_id <> OLD.bank_account_id
     OR NEW.paid_on <> OLD.paid_on THEN
    RAISE EXCEPTION 'bordereau non modifiable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bank_slips_decided
  BEFORE UPDATE ON bank_slips
  FOR EACH ROW EXECUTE FUNCTION app.forbid_decided_slip_change();

DO $$
DECLARE
  t text;
  tenant uuid;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_accounts', 'bank_slips'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
  END LOOP;

  -- Nouvelle permission pour les universités existantes (Recteur et SG administratif).
  FOR tenant IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', tenant::text, true);
    INSERT INTO role_permissions (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, 'payments:validate'
      FROM roles r
     WHERE r.is_system AND r.key IN ('rector', 'sg_administration')
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

GRANT SELECT, INSERT, UPDATE ON bank_accounts, bank_slips TO elongo_app, elongo_platform;
