import { buildSchema, graphql } from "graphql";

interface Env {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatPayload = {
  messages?: ChatMessage[];
  prompt?: string;
  system?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
};

type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ChatResult = {
  message: ChatMessage | null;
  usage: ChatUsage | null;
  raw: unknown;
};

type GraphQLChatInput = {
  messages?: ChatMessage[];
  prompt?: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
};

class HttpError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });

async function runChat(body: ChatPayload, env: Env): Promise<ChatResult> {
  if (!env.OPENAI_API_KEY) {
    throw new HttpError("OPENAI_API_KEY is not configured", 500);
  }

  if (!body.messages && !body.prompt) {
    throw new HttpError("Provide either `messages` or `prompt` in the request body");
  }

  const messages =
    body.messages ??
    [
      body.system ? ({ role: "system", content: body.system } as ChatMessage) : null,
      { role: "user", content: body.prompt ?? "" }
    ].filter(Boolean) as ChatMessage[];

  const baseUrl = (env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");

  const upstreamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: body.model ?? DEFAULT_MODEL,
      temperature: body.temperature ?? 0.2,
      max_tokens: body.max_tokens,
      stream: body.stream ?? false,
      messages
    })
  });

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    throw new HttpError(`OpenAI request failed: ${errorText}`, upstreamResponse.status);
  }

  const data = await upstreamResponse.json();
  return {
    message: data.choices?.[0]?.message ?? null,
    usage: data.usage ?? null,
    raw: data
  };
}

async function handleJson(request: Request, env: Env): Promise<Response> {
  let body: ChatPayload;
  try {
    body = (await request.json()) as ChatPayload;
  } catch {
    return jsonResponse(400, { error: "Request body must be valid JSON" });
  }

  try {
    const result = await runChat(body, env);
    return jsonResponse(200, result);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.message });
    }
    return jsonResponse(500, { error: "Unexpected error" });
  }
}

const schema = buildSchema(`
  type ChatMessage {
    role: String!
    content: String
  }

  type Usage {
    promptTokens: Int
    completionTokens: Int
    totalTokens: Int
  }

  type ChatPayload {
    message: ChatMessage
    usage: Usage
  }

  input ChatMessageInput {
    role: String!
    content: String!
  }

  input ChatInput {
    messages: [ChatMessageInput!]
    prompt: String
    system: String
    model: String
    temperature: Float
    maxTokens: Int
    stream: Boolean
  }

  type Query {
    _empty: String
  }

  type Mutation {
    chat(input: ChatInput!): ChatPayload!
  }
`);

const rootValue = {
  chat: async ({ input }: { input: GraphQLChatInput }, context: { env: Env }) => {
    try {
      const payload: ChatPayload = {
        ...input,
        max_tokens: input.maxTokens
      };
      const result = await runChat(payload, context.env);
      return {
        message: result.message,
        usage: result.usage
          ? {
              promptTokens: result.usage.prompt_tokens ?? null,
              completionTokens: result.usage.completion_tokens ?? null,
              totalTokens: result.usage.total_tokens ?? null
            }
          : null
      };
    } catch (error) {
      if (error instanceof HttpError) {
        const graphQLError = new Error(error.message);
        (graphQLError as Error & { extensions?: Record<string, unknown> }).extensions = {
          status: error.status
        };
        throw graphQLError;
      }
      throw error;
    }
  }
};

type GraphQLParams = {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

async function parseGraphQLParams(request: Request): Promise<GraphQLParams> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const rawVariables = url.searchParams.get("variables");
    let variables: Record<string, unknown> | undefined;
    if (rawVariables) {
      try {
        variables = JSON.parse(rawVariables);
      } catch {
        throw new HttpError("`variables` query param must be valid JSON");
      }
    }
    return {
      query: url.searchParams.get("query") ?? undefined,
      operationName: url.searchParams.get("operationName") ?? undefined,
      variables
    };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as GraphQLParams;
  }

  const text = await request.text();
  return { query: text };
}

async function handleGraphQL(request: Request, env: Env): Promise<Response> {
  try {
    const params = await parseGraphQLParams(request);
    if (!params.query) {
      return jsonResponse(400, { error: "GraphQL `query` is required" });
    }

    const result = await graphql({
      schema,
      source: params.query,
      variableValues: params.variables,
      operationName: params.operationName ?? undefined,
      rootValue,
      contextValue: { env }
    });

    const status = result.errors ? 400 : 200;
    return jsonResponse(status, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "GraphQL execution failed";
    return jsonResponse(400, { error: message });
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const { pathname } = new URL(request.url);
    if (pathname === "/graphql") {
      return handleGraphQL(request, env);
    }

    if (request.method === "POST") {
      return handleJson(request, env);
    }

    return jsonResponse(200, {
      status: "ok",
      message:
        "POST JSON to / for REST style chat completions or send GraphQL queries to /graphql."
    });
  }
};

export default worker;
