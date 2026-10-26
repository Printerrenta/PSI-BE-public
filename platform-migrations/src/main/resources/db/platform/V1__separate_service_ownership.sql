-- PostgreSQL executes this entire migration transactionally. Keep legacy HTTP writes stopped.
SET lock_timeout = '30s';
DO $$
DECLARE item record; n bigint; fk record;
BEGIN
 IF to_regclass('public.rental_requests') IS NULL THEN
  RETURN; -- Fresh installation: services create their own schemas with their Flyway histories.
 END IF;
 LOCK TABLE public.app_users,public.rental_requests,public.printers,public.rental_contracts,public.contract_attachments IN ACCESS EXCLUSIVE MODE;
 -- Validate all targets BEFORE changing anything. Never replace a populated service table.
 FOR item IN SELECT * FROM (VALUES
  ('identity','app_users'),('rental','rental_requests'),('rental','printers'),
  ('rental','rental_contracts'),('documents','contract_attachments')) v(s,t)
 LOOP
  IF to_regclass(format('%I.%I',item.s,item.t)) IS NOT NULL THEN
   EXECUTE format('SELECT count(*) FROM %I.%I',item.s,item.t) INTO n;
   IF n<>0 THEN RAISE EXCEPTION 'Migration target %.% is not empty',item.s,item.t; END IF;
  END IF;
 END LOOP;
 -- The attachment/contract relationship is now checked via the rental HTTP API.
 FOR fk IN SELECT conname FROM pg_constraint WHERE conrelid='public.contract_attachments'::regclass AND contype='f'
 LOOP EXECUTE format('ALTER TABLE public.contract_attachments DROP CONSTRAINT %I',fk.conname); END LOOP;
 -- Empty new tables may have local dependencies; remove children first without CASCADE.
 DROP TABLE IF EXISTS documents.contract_attachments;
 DROP TABLE IF EXISTS rental.rental_contracts;
 DROP TABLE IF EXISTS rental.rental_requests;
 DROP TABLE IF EXISTS rental.printers;
 DROP TABLE IF EXISTS identity.app_users;
 FOR item IN SELECT * FROM (VALUES
  ('identity','app_users','psi_identity'),('rental','printers','psi_rental'),
  ('rental','rental_requests','psi_rental'),('rental','rental_contracts','psi_rental'),
  ('documents','contract_attachments','psi_documents')) v(s,t,role_name)
 LOOP
  EXECUTE format('ALTER TABLE public.%I SET SCHEMA %I',item.t,item.s);
  EXECUTE format('ALTER TABLE %I.%I OWNER TO %I',item.s,item.t,item.role_name);
 END LOOP;
END $$;
