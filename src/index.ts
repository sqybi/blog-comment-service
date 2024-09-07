/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Queue consumer: a Worker that can consume from a
 * Queue: https://developers.cloudflare.com/queues/get-started/
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext/browser';

type PostCommentEvent = {
  // The unique identifier of the article, e.g., the last part of the URL, required
  article_id: string;

  // The parent comment ID, if any
  parent_comment_id?: number;

  // The author's display name, required
  author: string;

  // The author's email address
  email?: string;

  // The author's personal website
  website?: string;

  // Markdown content of the comment
  content: string;

  // Comment timestamp (UTC) in milliseconds, comment insert time by default
  timestamp_ms?: number;
};

type FetchCommentEvent = {
  // Fetch all comments for an article or subcomments from a comment
  comment_base_type: 'article' | 'comment';

  // comment_base_type=article: Identifier of the article
  // comment_base_type=comment: The comment ID
  comment_base_id: string | number;

  // Recursively fetch all subcomments
  is_recursive: boolean;
};

type Comment = {
  // The unique identifier of the comment
  id: number;

  // The author's display name
  author: string;

  // The author's email address, empty means no email
  email: string;

  // The author's personal website, empty means no website
  website: string;

  // HTML content of the comment
  content: string;

  // Comment timestamp (UTC) in milliseconds
  comment_timestamp_ms: number;

  // Subcomments
  children: Comment[];
};

class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Max-Age': '86400', // 24 hours
  'Access-Control-Allow-Headers': 'Content-Type, Range, X-Request-With',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

// TODO(sqybi): Cloudflare R2 needs a `Origin` header to allow CORS, so <link rel="stylesheet"> and fonts preload will not work.
const htmlCommon = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <style>
      body {
        font-family: "Noto Serif SC", system-ui, -apple-system, Segoe UI, Roboto,
          Ubuntu, Cantarell, Noto Sans, sans-serif, BlinkMacSystemFont,
          "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji",
          "Segoe UI Emoji", "Segoe UI Symbol";
        line-height: 1.6;
        color: #6b8541;
      }
      .container {
        width: 80%;
        margin: auto;
        padding: 20px;
        width: 600px;
        border: 1px solid #ddd;
        border-radius: 10px;
        background-color: #e4e2d3;
      }
      .header {
        text-align: center;
        padding-bottom: 20px;
        color: #ffffff;
        background-color: #8bac55;
        padding: 10px;
        border-radius: 0.3rem;
        box-shadow: 0 0 5px #6b8541;
      }
      .comment,
      .reply {
        border: none;
        border-radius: 4px 20px 4px 4px;
        box-shadow: 0 0 8px #6b8541;
        padding: 10px;
        background-color: #f9f9f9;
      }
      .info {
        border: 1px dashed #6b8541;
        border-radius: 2px 2px 2px 2px;
        box-shadow: 0 0 2px #6b8541;
        font-size: 80%;
        padding: 10px;
        background-color: #f9f9f9;
        text-align: center;
      }
      .footer {
        text-align: center;
        padding-top: 20px;
        font-size: 0.9em;
        color: #777;
      }
      .spacing {
        padding: 10px;
        background-color: transparent;
      }
      .comment-time {
        font-size: 80%;
        font-weight: normal;
        color: #888888;
        padding: 2px 3px;
        border: 1px dotted #888888;
        border-radius: 5px;
      }
      .comment h3,
      .reply h3 {
        color: #6b8541;
      }
      a {
        color: #8bac55;
        text-decoration: none;
        font-weight: bold;
      }
      a:hover {
        color: #6b8541;
      }
    </style>
  </head>
`;

const htmlCommentReply = `
  <body>
    <div class="container">
      <div class="header">
        <h2>Your Comment Received a Reply!</h2>
      </div>
      <div class="spacing"></div>
      <div class="comment">
        <h3>
          Your Comment
          <span class="comment-time">@ $ORIGINAL_COMMENT_TIME</span>
        </h3>
        <p>$ORIGINAL_COMMENT</p>
      </div>
      <div class="spacing"></div>
      <div class="reply">
        <h3>
          Reply from $REPLIED_AUTHOR_NAME
          <span class="comment-time">@ $REPLIED_COMMENT_TIME</span>
        </h3>
        <p>$REPLIED_COMMENT</p>
      </div>
      <div class="spacing"></div>
      <div class="info">Any subsequent replies to your comment will trigger notification emails.</div>
      <div class="footer">
        <p>
          Copyright © 2023-2024 <a href="https://sqybi.com/">SQYBI.com</a><br />
          Built with Docusaurus. Served by Cloudflare.
        </p>
      </div>
    </div>
  </body>
</html>
`;

const htmlCommentPosted = `
  <body>
    <div class="container">
      <div class="header">
        <h2>You Posted a New Comment!</h2>
      </div>
      <div class="spacing"></div>
      <div class="comment">
        <h3>
          Your Comment
          <span class="comment-time">@ $ORIGINAL_COMMENT_TIME</span>
        </h3>
        <p>$ORIGINAL_COMMENT</p>
      </div>
      <div class="spacing"></div>
      <div class="info">
        Any subsequent replies to your comment will trigger notification emails.
      </div>
      <div class="footer">
        <p>
          Copyright © 2023-2024 <a href="https://sqybi.com/">SQYBI.com</a><br />
          Built with Docusaurus. Served by Cloudflare.
        </p>
      </div>
    </div>
  </body>
</html>
`;

const textCommentReply = `
Your Comment Received a Reply!

Your Comment @ $ORIGINAL_COMMENT_TIME:

$ORIGINAL_COMMENT

Reply from $REPLIED_AUTHOR_NAME @ $REPLIED_COMMENT_TIME:

$REPLIED_COMMENT

Any subsequent replies to your comment will trigger notification emails.

<Copyright © 2023-2024 SQYBI.com>
`;

const textCommentPosted = `
You Posted a New Comment!

Your Comment @ $ORIGINAL_COMMENT_TIME:

$ORIGINAL_COMMENT

Any subsequent replies to your comment will trigger notification emails.

<Copyright © 2023-2024 SQYBI.com>
`;

const setCorsHeaderToResponse = async (
  request: Request,
  response: Response,
  allowedOrigins: string[]
): Promise<Response> => {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return new Response('Origin header not found', { status: 400 });
  }
  let is_allowed = false;
  for (const allowedOrigin of allowedOrigins) {
    if (allowedOrigin == '*') {
      is_allowed = true;
      break;
    } else if (allowedOrigin.startsWith('/') && allowedOrigin.endsWith('/')) {
      // Regex
      if (RegExp(allowedOrigin.substring(1, allowedOrigin.length - 1)).test(origin)) {
        is_allowed = true;
        break;
      }
    } else {
      if (origin === allowedOrigin) {
        if (allowedOrigins.includes(origin)) {
          is_allowed = true;
          break;
        }
      }
    }
  }
  if (is_allowed) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }

  const new_headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    new_headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new_headers,
  });
};

const sendCommentReplyNotificationEmail = async (
  mailer: SendEmail,
  original_comment: string,
  original_comment_markdown: string,
  original_timestamp: number,
  original_email: string,
  original_author_name: string,
  replied_comment: string,
  replied_comment_markdown: string,
  replied_timestamp: number,
  replied_author_name: string,
  locale: string = 'en-US'
): Promise<boolean> => {
  const fillInfo = (text: string, is_markdown: boolean) =>
    text
      .replaceAll('$ORIGINAL_COMMENT_TIME', new Date(original_timestamp).toLocaleString(locale))
      .replaceAll('$ORIGINAL_COMMENT', is_markdown ? original_comment_markdown : original_comment)
      .replaceAll('$REPLIED_COMMENT_TIME', new Date(replied_timestamp).toLocaleString(locale))
      .replaceAll('$REPLIED_COMMENT', is_markdown ? replied_comment_markdown : replied_comment)
      .replaceAll('$REPLIED_AUTHOR_NAME', replied_author_name);

  const html_text = fillInfo(htmlCommentReply, false);
  const plain_text = fillInfo(textCommentReply, true);

  const msg = createMimeMessage();
  msg.setSender({ name: 'SQYBI.com Comment System', addr: 'comment@sqybi.com' });
  msg.setRecipient({ addr: original_email, name: original_author_name });
  msg.setSubject('[SQYBI.com] Your Comment Received a Reply!');
  msg.addMessage({
    contentType: 'text/plain',
    data: plain_text,
  });
  msg.addMessage({
    contentType: 'text/html',
    data: html_text,
  });

  var message = new EmailMessage('comment@sqybi.com', original_email, msg.asRaw());
  try {
    await mailer.send(message);
  } catch (e) {
    return false;
  }
  return true;
};

const sendCommentPostedNotificationEmail = async (
  mailer: SendEmail,
  original_comment: string,
  original_comment_markdown: string,
  original_timestamp: number,
  original_email: string,
  original_author_name: string,
  locale: string = 'en-US'
): Promise<boolean> => {
  const fillInfo = (text: string, is_markdown: boolean) =>
    text
      .replaceAll('$ORIGINAL_COMMENT_TIME', new Date(original_timestamp).toLocaleString(locale))
      .replaceAll('$ORIGINAL_COMMENT', is_markdown ? original_comment_markdown : original_comment);

  const html_text = fillInfo(htmlCommon + htmlCommentPosted, false);
  const plain_text = fillInfo(textCommentPosted, true);

  const msg = createMimeMessage();
  msg.setSender({ name: 'SQYBI.com Comment System', addr: 'comment@sqybi.com' });
  msg.setRecipient({ addr: original_email, name: original_author_name });
  msg.setSubject('[SQYBI.com] You Posted a New Comment!');
  msg.addMessage({
    contentType: 'text/plain',
    data: plain_text,
  });
  msg.addMessage({
    contentType: 'text/html',
    data: html_text,
  });

  var message = new EmailMessage('comment@sqybi.com', original_email, msg.asRaw());
  try {
    await mailer.send(message);
  } catch (e) {
    return false;
  }
  return true;
};

const markdownToHtml = async (markdown: string): Promise<string> => {
  const file = await unified().use(remarkParse).use(remarkRehype).use(rehypeStringify).process(markdown);
  return file.toString();
};

const recursiveQuery = async (
  db: D1Database,
  base_type: 'article' | 'comment',
  parent_id: string | number,
  is_recursive: boolean
) => {
  const query_article = db.prepare(
    'SELECT id, author_name, author_email, author_website, html_content, comment_timestamp_ms, level \
     FROM comments \
     WHERE article_id = ?1 AND parent_id = 0'
  );
  const query_comment = db.prepare(
    'SELECT id, author_name, author_email, author_website, html_content, comment_timestamp_ms, level \
    FROM comments \
    WHERE parent_id = ?1'
  );
  const comments = [] as Comment[];

  const record =
    base_type === 'article' ? await query_article.bind(parent_id).all() : await query_comment.bind(parent_id).all();
  if (record.error) {
    throw new DatabaseError(record.error);
  }

  for (const result of record.results) {
    const comment = {
      id: result.id,
      author: result.author_name,
      email: result.author_email,
      website: result.author_website,
      content: result.html_content,
      comment_timestamp_ms: result.comment_timestamp_ms,
      children: [],
    } as Comment;

    if (is_recursive) {
      const subcomments = await recursiveQuery(db, 'comment', result.id as number, true);
      comment.children.push(...subcomments);
      // TODO(sqybi): Make sure the level of all subcomments is 1 greater than the parent
    }

    comments.push(comment);
  }

  return comments;
};

export default {
  // Our fetch handler is invoked on a HTTP request: we can send a message to a queue
  // during (or after) a request.
  // https://developers.cloudflare.com/queues/platform/javascript-apis/#producer
  async fetch(req, env, ctx): Promise<Response> {
    const getReponse = async (body?: BodyInit | null, init?: ResponseInit) =>
      setCorsHeaderToResponse(
        req,
        new Response(body, init),
        env.ALLOWED_ORIGINS.split(';').map((s: string) => s.trim())
      );

    try {
      const url = URL.parse(req.url);
      if (!url || url.pathname !== '/comment') {
        return getReponse('Not found', { status: 404 });
      }

      // OPTIONS request for CORS
      if (req.method === 'OPTIONS') {
        return getReponse('OK', { headers: corsHeaders, status: 200 });
      }

      // POST request for adding a new comment
      if (req.method === 'POST') {
        const event = (await req.json()) as PostCommentEvent;

        // Check parent comment existence
        let level = 0;
        let parent_comment = null;
        if (event.parent_comment_id) {
          const query = env.COMMENT_DB.prepare(
            'SELECT level, html_content, markdown_content, comment_timestamp_ms, author_email \
            FROM comments \
            WHERE id = ?1 \
            LIMIT 1'
          );
          parent_comment = await query.bind(event.parent_comment_id).first();
          if (!parent_comment) {
            console.warn(`Parent comment ${event.parent_comment_id} not found`);
            return getReponse('Parent comment not found', { status: 404 });
          }
          level = Number.parseInt(parent_comment.level as string) + 1;
        }

        // Convert markdown to HTML
        const html_content = await markdownToHtml(event.content);

        // Insert into D1 database
        const command = env.COMMENT_DB.prepare(
          'INSERT INTO comments ( \
          article_id, parent_id, level, author_name, author_email, author_website, markdown_content, html_content, \
          comment_timestamp_ms) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
        );
        const now = new Date().getTime();
        const result = await command
          .bind(
            event.article_id,
            event.parent_comment_id || 0,
            level,
            event.author,
            event.email || '',
            event.website || '',
            event.content,
            html_content,
            event.timestamp_ms || now
          )
          .run();
        if (result.error) {
          throw new DatabaseError(result.error);
        }

        const response_data = {
          success: true,
          email_notification: {
            author: 'skipped',
            reply: 'skipped',
          },
        };
        if (event.email) {
          const mail_sent = await sendCommentPostedNotificationEmail(
            env.MAILER,
            html_content,
            event.content,
            event.timestamp_ms || now,
            event.email,
            event.author
          );
          if (mail_sent) {
            response_data.email_notification.author = 'sent';
            console.log(`Email sent to ${event.email}`);
          } else {
            response_data.email_notification.author = 'failed';
            console.warn(`Failed to send email to ${event.email}`);
          }
        }
        if (parent_comment && parent_comment.author_email) {
          const mail_sent = await sendCommentReplyNotificationEmail(
            env.MAILER,
            parent_comment.html_content as string,
            parent_comment.markdown_content as string,
            parent_comment.comment_timestamp_ms as number,
            parent_comment.author_email as string,
            parent_comment.author_name as string,
            html_content,
            event.content,
            event.timestamp_ms || now,
            event.author
          );
          if (mail_sent) {
            response_data.email_notification.reply = 'sent';
            console.log(`Email sent to ${parent_comment.author_email}`);
          } else {
            response_data.email_notification.reply = 'failed';
            console.warn(`Failed to send email to ${parent_comment.author_email}`);
          }
        }
        return getReponse(JSON.stringify(response_data));
      }

      // GET request for fetching comments
      if (req.method === 'GET') {
        const params = url.searchParams;
        const fetch_event = {
          comment_base_type: params.get('comment_base_type') as 'article' | 'comment',
          comment_base_id: params.get('comment_base_id') as string,
          is_recursive: params.get('is_recursive') === 'true',
        } as FetchCommentEvent;
        if (fetch_event.comment_base_type === 'article') {
          // Check comment ID type
          if (Number.isInteger(fetch_event.comment_base_id)) {
            return getReponse('Invalid comment ID', { status: 400 });
          }
        } else if (fetch_event.comment_base_type === 'comment') {
          // Check comment ID type
          fetch_event.comment_base_id = Number(fetch_event.comment_base_id);
          if (!Number.isInteger(fetch_event.comment_base_id)) {
            return getReponse('Invalid comment ID', { status: 400 });
          }
        } else {
          return getReponse('Invalid comment base type', { status: 400 });
        }

        // Query D1 database
        const comments = await recursiveQuery(
          env.COMMENT_DB,
          fetch_event.comment_base_type,
          fetch_event.comment_base_id,
          fetch_event.is_recursive
        );

        return getReponse(JSON.stringify(comments));
      }

      // Other methods are not allowed
      return getReponse('Method not allowed', { status: 405 });
    } catch (e) {
      console.error(`Error catched:\n${(e as Error).message}\n`);
      if (e instanceof DatabaseError) {
        return getReponse('Database error', { status: 500 });
      }
      return getReponse('Internal server error', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
