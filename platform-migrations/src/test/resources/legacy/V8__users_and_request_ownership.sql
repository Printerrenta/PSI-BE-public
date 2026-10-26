CREATE TABLE app_users (
    subject VARCHAR(255) PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER' CHECK (role IN ('CUSTOMER', 'EMPLOYEE', 'ADMIN')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rental_requests ADD COLUMN owner_subject VARCHAR(255);
CREATE INDEX rental_requests_owner_idx ON rental_requests(owner_subject, created_at DESC, id DESC);
-- Legacy requests stay unowned; only employees and administrators can access them.
