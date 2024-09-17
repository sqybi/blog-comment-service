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

type PostCommentEvent = {
  // The unique identifier of the article, e.g., the last part of the URL, required
  article_id: string;

  // The original URL address when posting the comment
  // TODO(sqybi): Save this field to database
  article_original_url: string;

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

type EmailCommentProperties = {
  comment_id: number;
  comment_timestamp: number;
  author_name: string;
  author_email?: string;
  markdown_content: string;
};

type SendCommentNotificationEmailEvent = {
  comment: EmailCommentProperties;
  reply_to_comment: EmailCommentProperties | null;
};

type TelegramCommentProperties = {
  article_id: string;
  article_original_url: string;
  comment_id: number;
  comment_timestamp: number;
  author_name: string;
  author_email?: string;
  markdown_content: string;
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

type RecursiveQueryCommentsRow = {
  id: number;
  author_name: string;
  author_email: string;
  author_website: string;
  html_content: string;
  comment_timestamp_ms: number;
  level: number;
};

type ParentCommentsRow = {
  level: number;
  id: number;
  html_content: string;
  markdown_content: string;
  comment_timestamp_ms: number;
  author_name: string;
  author_email: string;
};

type IdOnlyCommentRow = {
  id: number;
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

const setCorsHeaderToResponse = async (
  request: Request,
  response: Response,
  allowedOrigins: string[]
): Promise<Response> => {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return new Response('Origin header not found', { status: 400 });
  }
  var is_allowed = false;
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
    base_type === 'article'
      ? await query_article.bind(parent_id).all<RecursiveQueryCommentsRow>()
      : await query_comment.bind(parent_id).all<RecursiveQueryCommentsRow>();
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

const registerRecipientEmail = async (email: string, api_key: string): Promise<boolean> => {
  const response = await fetch(
    new Request('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': api_key,
      },
      body: JSON.stringify({ email }),
    })
  );
  const response_data = (await response.json()) as { id?: string; code?: string };
  const result = !response.ok || ('id' in response_data && response_data.code != 'duplicate_parameter');
  if (!result) {
    console.warn(`Failed to register recipient email ${email}, response: ${response_data}`);
  }
  return result;
};

const postSendEmailRequest = async (data: any, api_key: string): Promise<boolean> => {
  const response = await fetch(
    new Request('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': api_key,
      },
      body: JSON.stringify(data),
    })
  );
  const response_data = (await response.json()) as { messageId?: string };
  if (!response.ok || !response_data.messageId) {
    console.error(`Failed to send email, response: ${response_data}`);
    return false;
  } else {
    console.log(`Email sent successfully, message ID: ${response_data.messageId}`);
  }
  return true;
};

const getDateString = (timestamp: number, locale?: string): string => {
  return new Date(timestamp).toLocaleString(locale ?? 'en-US', { dateStyle: 'long', timeStyle: 'medium' });
};

const sendEmail = async (email_event: SendCommentNotificationEmailEvent, api_key: string): Promise<boolean> => {
  // Send notification to current author
  const data = {
    to: [
      {
        email: email_event.comment.author_email,
        name: email_event.comment.author_name,
      },
    ],
    templateId: 2, // Template for comment posted notification
    params: {
      original: {
        comment_time: getDateString(email_event.comment.comment_timestamp),
        comment: email_event.comment.markdown_content,
      },
    },
  };
  var result = await postSendEmailRequest(data, api_key);

  // Send notification to parent author if exists
  if (email_event.reply_to_comment && email_event.comment.author_email !== email_event.reply_to_comment.author_email) {
    const data = {
      to: [
        {
          email: email_event.reply_to_comment.author_email,
          name: email_event.reply_to_comment.author_name,
        },
      ],
      templateId: 1, // Template for new reply notification
      params: {
        original: {
          comment_time: getDateString(email_event.reply_to_comment.comment_timestamp),
          comment: email_event.reply_to_comment.markdown_content,
        },
        replied: {
          author_name: email_event.comment.author_name,
          comment_time: getDateString(email_event.comment.comment_timestamp),
          comment: email_event.comment.markdown_content,
        },
      },
    };
    result = result && (await postSendEmailRequest(data, api_key));
  }

  return result;
};

export default {
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
        var level = 0;
        var parent_comment = null;
        if (event.parent_comment_id) {
          const parent_comment_query = env.COMMENT_DB.prepare(
            'SELECT level, id, html_content, markdown_content, comment_timestamp_ms, author_name, author_email \
            FROM comments \
            WHERE id = ?1 \
            LIMIT 1'
          );
          parent_comment = await parent_comment_query.bind(event.parent_comment_id).first<ParentCommentsRow>();
          if (!parent_comment) {
            console.warn(`Parent comment ${event.parent_comment_id} not found`);
            return getReponse('Parent comment not found', { status: 404 });
          }
          level = parent_comment.level + 1;
        }

        // Convert markdown to HTML
        const html_content = await markdownToHtml(event.content);

        // Insert into D1 database
        const insert_command = env.COMMENT_DB.prepare(
          'INSERT INTO comments ( \
          article_id, parent_id, level, author_name, author_email, author_website, markdown_content, html_content, \
          comment_timestamp_ms, uuid) \
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)'
        );
        const uuid = self.crypto.randomUUID();
        const send_time = new Date().getTime();
        const result = await insert_command
          .bind(
            event.article_id,
            event.parent_comment_id || 0,
            level,
            event.author,
            event.email || '',
            event.website || '',
            event.content,
            html_content,
            send_time,
            uuid
          )
          .run();
        if (result.error) {
          throw new DatabaseError(result.error);
        }

        // Send Telegram notification (queued)
        const last_insert_id_command = env.COMMENT_DB.prepare('SELECT id FROM comments WHERE uuid = ?1 LIMIT 1');
        const last_insert_id = await last_insert_id_command.bind(uuid).first<IdOnlyCommentRow>();
        if (!last_insert_id) {
          console.error('Failed to get last insert ID. This should never happen!');
          return getReponse('OK');
        }
        const comment_properties = {
          article_id: event.article_id,
          article_original_url: event.article_original_url,
          comment_id: last_insert_id.id,
          comment_timestamp: send_time,
          author_name: event.author,
          author_email: event.email,
          markdown_content: event.content,
        } as TelegramCommentProperties;
        await env.MESSAGE_QUEUE.send(comment_properties);

        // Send email notification (queued)
        if (event.email) {
          const email_event = {
            comment: comment_properties,
            reply_to_comment: parent_comment
              ? {
                  comment_id: parent_comment.id,
                  comment_timestamp: parent_comment.comment_timestamp_ms,
                  author_name: parent_comment.author_name,
                  author_email: parent_comment.author_email,
                  markdown_content: parent_comment.markdown_content,
                }
              : null,
          } as SendCommentNotificationEmailEvent;
          await env.EMAIL_QUEUE.send(email_event);
        }

        return getReponse('OK');
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

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = message.body;

        // Try register recipient email, ignore failure when already added
        if (!event.comment.author_email) {
          console.error('Email address not found in comment event, will not retry');
          message.ack();
          continue;
        }
        await registerRecipientEmail(event.comment.author_email, env.BREVO_API_KEY);
        if (event.reply_to_comment) {
          if (!event.reply_to_comment.author_email) {
            console.error('Email address not found in reply_to_comment event, will not retry');
            message.ack();
            continue;
          }
          await registerRecipientEmail(event.reply_to_comment.author_email, env.BREVO_API_KEY);
        }

        // Send email notification
        if (await sendEmail(event, env.BREVO_API_KEY)) {
          message.ack();
        } else {
          message.retry();
        }
      } catch (e) {
        console.error(`Error catched:\n${(e as Error).message}\n`);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, SendCommentNotificationEmailEvent>;
