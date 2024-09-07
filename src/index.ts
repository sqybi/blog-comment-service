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

const setCorsHeaderToResponse = async (
  request: Request,
  response: Response,
  allowedOrigins: string[]
): Promise<Response> => {
  const origin = request.headers.get('Origin');
  if (!origin) {
    return new Response('Origin header not found', { status: 400 });
  }
  if (allowedOrigins.includes(origin)) {
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
        if (event.parent_comment_id) {
          const query = env.COMMENT_DB.prepare(
            'SELECT level \
            FROM comments \
            WHERE id = ?1 \
            LIMIT 1'
          );
          const parent_comment = await query.bind(event.parent_comment_id).first();
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
            event.timestamp_ms || new Date().getTime()
          )
          .run();
        if (result.error) {
          throw new DatabaseError(result.error);
        }
        console.log(result.results);
        return getReponse('{}');
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
