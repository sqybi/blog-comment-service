-- Create Table
CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id TEXT,
    parent_id INTEGER,
    level INTEGER,
    author_name TEXT,
    author_email TEXT,
    author_website TEXT,
    markdown_content TEXT,
    html_content TEXT,
    comment_timestamp_ms INTEGER,
    uuid TEXT
);

-- Create Indexes
CREATE INDEX IF NOT EXISTS idx_orders_comments_id ON comments(id);
CREATE INDEX IF NOT EXISTS idx_orders_comments_article_id ON comments(article_id);
CREATE INDEX IF NOT EXISTS idx_orders_comments_parent_id ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_orders_comments_uuid ON comments(uuid);

-- Copy from old table to new table
INSERT INTO comments_new (
    id,
    article_id,
    parent_id,
    level,
    author_name,
    author_email,
    author_website,
    markdown_content,
    html_content,
    comment_timestamp_ms
)
SELECT
    id,
    article_id,
    parent_id,
    level,
    author_name,
    author_email,
    author_website,
    markdown_content,
    html_content,
    comment_timestamp_ms
FROM comments;

-- Drop old table and replace with new table
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
