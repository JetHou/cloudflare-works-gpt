import { GraphQLError, buildSchema, graphql } from "graphql";

interface Env {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
  API_BASE_PATH?: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

class WorkerError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "BAD_REQUEST") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type GraphQLParams = {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

type ChatMessage = {
  role: string;
  content: string;
  createdAt: string;
};

const schema = buildSchema(`
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
`);

async function callOpenAI(prompt: string, env: Env): Promise<ChatMessage> {
  const trimmedPrompt = prompt?.trim();
  if (!trimmedPrompt) {
    throw new WorkerError("prompt is required", 400, "PROMPT_REQUIRED");
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new WorkerError("OPENAI_API_KEY is not configured", 500, "OPENAI_CONFIG_MISSING");
  }

  const baseUrl = (env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: trimmedPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new WorkerError(`OpenAI request failed: ${errorText}`, response.status, "OPENAI_ERROR");
  }

  const data = await response.json();
  const choice = data.choices?.[0]?.message;
  const createdTimestamp = data.created ? Number(data.created) * 1000 : Date.now();

  return {
    role: choice?.role ?? "assistant",
    content: choice?.content ?? "",
    createdAt: new Date(createdTimestamp).toISOString()
  };
}

const rootValue = {
  _ping: () => "pong",
  chat: async ({ prompt }: { prompt: string }, context: { env: Env }) => {
    try {
      return await callOpenAI(prompt, context.env);
    } catch (error) {
      if (error instanceof WorkerError) {
        throw new GraphQLError(error.message, {
          extensions: {
            code: error.code,
            status: error.status
          }
        });
      }

      throw new GraphQLError("Unknown error", {
        extensions: { code: "INTERNAL_ERROR", status: 500 }
      });
    }
  }
};

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });

async function parseGraphQLParams(request: Request): Promise<GraphQLParams> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? undefined;
    const operationName = url.searchParams.get("operationName") ?? undefined;
    const rawVariables = url.searchParams.get("variables");

    if (rawVariables) {
      try {
        return {
          query,
          operationName,
          variables: JSON.parse(rawVariables)
        };
      } catch {
        throw new WorkerError("`variables` must be valid JSON", 400, "INVALID_VARIABLES");
      }
    }

    return { query, operationName };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return (await request.json()) as GraphQLParams;
    } catch {
      throw new WorkerError("Request body must be valid JSON", 400, "INVALID_JSON");
    }
  }

  const text = await request.text();
  return { query: text };
}

function normalizeGraphQLResult(result: Awaited<ReturnType<typeof graphql>>) {
  const errors = result.errors?.map(error => ({
    message: error.message,
    locations: error.locations,
    path: error.path,
    extensions: {
      status: error.extensions?.status ?? 500,
      code: (error.extensions?.code as string | undefined) ?? "GRAPHQL_ERROR",
      ...error.extensions
    }
  }));

  return {
    data: result.data ?? null,
    ...(errors ? { errors } : {})
  };
}

async function handleGraphQL(request: Request, env: Env): Promise<Response> {
  try {
    const params = await parseGraphQLParams(request);
    if (!params.query) {
      throw new WorkerError("GraphQL `query` is required", 400, "QUERY_REQUIRED");
    }

    const result = await graphql({
      schema,
      source: params.query,
      variableValues: params.variables,
      operationName: params.operationName ?? undefined,
      rootValue,
      contextValue: { env }
    });

    const payload = normalizeGraphQLResult(result);
    const status = result.errors?.[0]?.extensions?.status
      ? Number(result.errors[0].extensions.status)
      : result.errors
        ? 400
        : 200;

    return jsonResponse(status, payload);
  } catch (error) {
    if (error instanceof WorkerError) {
      return jsonResponse(error.status, {
        data: null,
        errors: [
          {
            message: error.message,
            extensions: {
              status: error.status,
              code: error.code
            }
          }
        ]
      });
    }

    return jsonResponse(500, {
      data: null,
      errors: [
        {
          message: error instanceof Error ? error.message : "GraphQL execution failed",
          extensions: {
            status: 500,
            code: "INTERNAL_ERROR"
          }
        }
      ]
    });
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const graphqlPath = env.API_BASE_PATH ?? "/graphql";
    if (url.pathname !== graphqlPath) {
      return jsonResponse(404, {
        data: null,
        errors: [
          {
            message: "Not Found",
            extensions: { status: 404, code: "NOT_FOUND" }
          }
        ]
      });
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse(405, {
        data: null,
        errors: [
          {
            message: "Only GET/POST are supported",
            extensions: { status: 405, code: "METHOD_NOT_ALLOWED" }
          }
        ]
      });
    }

    return handleGraphQL(request, env);
  }
};

export default worker;
