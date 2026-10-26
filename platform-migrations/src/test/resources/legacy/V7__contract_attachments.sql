CREATE TABLE contract_attachments (
    id UUID PRIMARY KEY,
    contract_id UUID NOT NULL REFERENCES rental_contracts(id),
    object_key VARCHAR(200) NOT NULL UNIQUE,
    filename VARCHAR(200) NOT NULL,
    content_type VARCHAR(120) NOT NULL,
    byte_size BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX contract_attachments_contract_idx ON contract_attachments (contract_id, created_at DESC, id DESC);
