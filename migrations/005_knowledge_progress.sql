ALTER TABLE relay.knowledge_files DROP CONSTRAINT IF EXISTS knowledge_files_size_bytes_check;
ALTER TABLE relay.knowledge_files ADD CONSTRAINT knowledge_files_size_bytes_check CHECK(size_bytes > 0 AND size_bytes <= 10485760);
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100);
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS progress_stage text NOT NULL DEFAULT 'Queued';
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS progress_detail text;
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS processed_chunks integer NOT NULL DEFAULT 0;
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS total_chunks integer NOT NULL DEFAULT 0;
ALTER TABLE relay.knowledge_files ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz NOT NULL DEFAULT now();
