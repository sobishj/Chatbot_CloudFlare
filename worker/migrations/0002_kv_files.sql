-- Files moved from R2 to Workers KV (binding FILES_KV), under the same keys.
-- r2_key and text_r2_key keep their names and now hold KV keys.
--
-- upload_hash: SHA-256 of the file as uploaded. KV is eventually consistent, so the indexer
-- checks the file it reads against this hash and waits when KV still returns an older copy.
ALTER TABLE documents ADD COLUMN upload_hash TEXT;
