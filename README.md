## GraphQL GPT Cloudflare Worker

该 Worker 部署在 Cloudflare Workers/Pages 上，并通过 `https://api.jethoui7.online/graphql` 暴露 GraphQL 接口，负责把前端的聊天请求安全地代理到 OpenAI。

### 功能概览

- `_ping` 查询用于健康检查。
- `chat` mutation 接收 `prompt` 字符串，调用 OpenAI `gpt-4o-mini`，返回 `role`、`content`、`createdAt`。
- 统一的 GraphQL 错误结构，方便 React 前端消费。

### 本地开发

```bash
npm install
wrangler dev --local
```

开发时可直接向 `http://127.0.0.1:8787/graphql` 发起请求：

```bash
curl -X POST http://127.0.0.1:8787/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($prompt:String!){ chat(prompt:$prompt){ role content createdAt }}","variables":{"prompt":"你好，Cloudflare Worker！"}}'
```

### 配置 OpenAI 密钥

```bash
wrangler secret put OPENAI_API_KEY
# 粘贴新的 sk- 开头的 key
```

### 部署

```bash
wrangler deploy
```

- 如果要绑定自定义域名 `api.jethoui7.online`，在 Cloudflare 控制台或 `wrangler.toml` 中配置对应的 routes/custom_domain，再将前端请求指向 `https://api.jethoui7.online/graphql`。

### GraphQL Schema

```graphql
type Query {
  _ping: String!
}

type ChatMessage {
  role: String!
  content: String!
  createdAt: String!
}

type Mutation {
  chat(prompt: String!): ChatMessage!
}
```

### 错误格式

所有错误都会以 GraphQL 标准格式返回，例如：

```json
{
  "data": null,
  "errors": [
    {
      "message": "OPENAI_API_KEY is not configured",
      "extensions": {
        "status": 500,
        "code": "OPENAI_CONFIG_MISSING"
      }
    }
  ]
}
```

前端可以依赖 `errors[].extensions.status` 和 `errors[].extensions.code` 做进一步处理。
