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

const TELEGRAM_MESSAGE_LENGTH_LIMIT = 4096;

type EmailCommentProperties = {
  comment_id: number;
  comment_timestamp: number;
  author_name: string;
  author_email: string;
  markdown_content: string;
};

export default {
  async fetch(req, env, ctx): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  // The queue handler is invoked when a batch of messages is ready to be delivered
  // https://developers.cloudflare.com/queues/platform/javascript-apis/#messagebatch
  async queue(batch, env): Promise<void> {
    for (let message of batch.messages) {
      const msg = message.body;
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: parseInt(env.TELEGRAM_CHAT_ID),
          text: `你收到了来自 ${msg.author_name} ${msg.author_email ? `(${msg.author_email}) ` : ''}的博客评论！\n\n${
            msg.markdown_content
          }`.substring(0, TELEGRAM_MESSAGE_LENGTH_LIMIT),
        }),
      });
      const response_json = (await response.json()) as any;
      if (!response_json.ok) {
        console.error(`Failed to send message to Telegram:\n${JSON.stringify(response_json)}`);
        message.retry();
      } else {
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, EmailCommentProperties>;
