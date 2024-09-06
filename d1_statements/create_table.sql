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
    comment_timestamp_ms INTEGER
);

-- Create Indexes
CREATE INDEX IF NOT EXISTS idx_orders_comments_id ON comments(id);
CREATE INDEX IF NOT EXISTS idx_orders_comments_article_id ON comments(article_id);
CREATE INDEX IF NOT EXISTS idx_orders_comments_parent_id ON comments(parent_id);