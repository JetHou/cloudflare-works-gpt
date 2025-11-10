## Cloudflare GPT Proxy Worker

This project exposes a small Cloudflare Worker that forwards chat-style requests to OpenAI's API. It is meant to sit behind your Cloudflare Pages frontend so that the browser never touches your OpenAI key directly.

### Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) logged into the same Cloudflare account as your Pages project.
- Node.js 18+ (only required if you want to edit TypeScript locally).

### Local development

```bash
npm install
wrangler dev
```

Send a POST request to `http://127.0.0.1:8787` with either a `messages` array or a plain `prompt`:

```bash
curl -X POST http://127.0.0.1:8787 \
  -H "Content-Type: application/json" \
  -d '{"prompt":"你好，Worker！"}'
```

### Configure secrets

Never hard-code your OpenAI key in the repo. Store it as a Worker secret:

```bash
wrangler secret put OPENAI_API_KEY
# paste: sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

You can optionaly override the API base (for Azure/OpenAI compatible providers) by setting `OPENAI_BASE_URL` in `wrangler.toml` or via `wrangler secret/kv`.

### Deploy to Cloudflare

```bash
wrangler deploy
```

- For a standalone Worker, the CLI output will show the public URL.
- For a Pages project, go to **Pages → Settings → Functions** and connect this repo so the Worker runs as the Pages backend. Pages will detect `wrangler.toml` automatically.

### Request/response shape

Request body (either `messages` or `prompt` is required):

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "用中文介绍一下 Cloudflare Workers。" }
  ],
  "temperature": 0.3,
  "max_tokens": 300
}
```

Response:

```json
{
  "message": {
    "role": "assistant",
    "content": "..."
  },
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 120,
    "total_tokens": 145
  },
  "raw": { "...full OpenAI payload..." }
}
```

### GraphQL endpoint

The Worker also exposes `/graphql` for clients that prefer GraphQL. Example mutation:

```graphql
mutation Chat($prompt: String!) {
  chat(
    input: {
      prompt: $prompt
      system: "You are a helpful assistant."
      model: "gpt-4o-mini"
    }
  ) {
    message {
      role
      content
    }
    usage {
      promptTokens
      completionTokens
      totalTokens
    }
  }
}
```

Call it via `curl`:

```bash
curl -X POST https://<your-worker>/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation Chat($prompt:String!){ chat(input:{ prompt:$prompt }) { message { role content } } }","variables":{"prompt":"介绍一下 Cloudflare Workers"}}'
```

### Notes

- CORS is enabled for `GET`, `POST`, and `OPTIONS`, so you can call the Worker directly from Pages or another frontend (REST or GraphQL).
- `stream: true` is accepted but currently proxied as a standard JSON response. Add a streaming reader if you need Server-Sent Events in the future.
- Remember to rotate and protect your `OPENAI_API_KEY`; anyone with the token can use your OpenAI quota.
