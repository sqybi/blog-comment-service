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
