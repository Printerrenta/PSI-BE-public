-- Development-only passwords; the production provisioner generates random credentials.
CREATE ROLE psi_identity LOGIN PASSWORD 'identity_local';
CREATE ROLE psi_rental LOGIN PASSWORD 'rental_local';
CREATE ROLE psi_documents LOGIN PASSWORD 'documents_local';
CREATE ROLE psi_notifications LOGIN PASSWORD 'notifications_local';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA identity AUTHORIZATION psi_identity;
CREATE SCHEMA rental AUTHORIZATION psi_rental;
CREATE SCHEMA documents AUTHORIZATION psi_documents;
CREATE SCHEMA notifications AUTHORIZATION psi_notifications;
CREATE ROLE psi_metering LOGIN PASSWORD 'metering_local';
CREATE ROLE psi_billing LOGIN PASSWORD 'billing_local';
CREATE SCHEMA metering AUTHORIZATION psi_metering;
CREATE SCHEMA billing AUTHORIZATION psi_billing;
