#!/usr/bin/env bun
import http from "node:http";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  tools?: Record<string, unknown>[];
}

interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: {
      role: "assistant";
      content: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    delta?: {
      role?: "assistant";
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

// Deterministic golden response for hermeticity in tests
function getDeterministicResponse(messages: ChatMessage[]): string {
  const lastMessage = messages[messages.length - 1]?.content || "";

  if (lastMessage.toLowerCase().includes("hello")) {
    return "Hello! I'm a deterministic provider server for e2e testing. How can I help?";
  }

  if (lastMessage.toLowerCase().includes("tool")) {
    return "I can call tools. Here's an example.";
  }

  if (lastMessage.toLowerCase().includes("math")) {
    return "2 + 2 = 4";
  }

  // Default golden response
  return "Golden test response from deterministic provider.";
}

// Tool call example (deterministic for golden flows)
function getDeterministicToolCall(): Array<{
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}> {
  return [
    {
      id: "call_001",
      type: "function",
      function: {
        name: "test_tool",
        arguments: JSON.stringify({ input: "test" }),
      },
    },
  ];
}

function createChatResponse(
  messages: ChatMessage[],
  model: string,
  stream: boolean,
  includeTools: boolean
): ChatResponse {
  const timestamp = Math.floor(Date.now() / 1000);
  const responseText = getDeterministicResponse(messages);

  const choice: ChatResponse["choices"][0] = {
    index: 0,
    message: {
      role: "assistant",
      content: responseText,
    },
    finish_reason: "stop",
  };

  if (includeTools && choice.message) {
    choice.message.tool_calls = [
      {
        id: `call_${Date.now()}`,
        type: "function",
        function: {
          name: "get_weather",
          arguments: JSON.stringify({ location: "San Francisco" }),
        },
      },
    ];
    choice.finish_reason = "tool_calls";
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: timestamp,
    model,
    choices: [choice],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);

  // Strict CORS for e2e testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Models endpoint
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const models: { data: Model[]; object: string } = {
      object: "list",
      data: [
        {
          id: "test-model",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "provider-server",
        },
      ],
    };
    res.end(JSON.stringify(models));
    return;
  }

  // Chat completions endpoint
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      let payload: ChatRequest;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const model = payload.model || "test-model";
      const stream = payload.stream || false;
      const includeTools = (payload.tools || []).length > 0;

      if (stream) {
        // SSE streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // Send streaming chunks
        const response = createChatResponse(
          payload.messages,
          model,
          true,
          includeTools
        );
        const choice = response.choices[0];

        // First delta with role
        const deltaStart: ChatResponse = {
          id: response.id,
          object: "chat.completion.chunk",
          created: response.created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(deltaStart)}\n\n`);

        // Content delta
        const content = choice.message?.content || "";
        const deltaContent: ChatResponse = {
          id: response.id,
          object: "chat.completion.chunk",
          created: response.created,
          model,
          choices: [
            {
              index: 0,
              delta: { content },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(deltaContent)}\n\n`);

        // Final message with tool_calls if present
        if (choice.message?.tool_calls) {
          const deltaTools: ChatResponse = {
            id: response.id,
            object: "chat.completion.chunk",
            created: response.created,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: choice.message.tool_calls,
                },
                finish_reason: "tool_calls",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(deltaTools)}\n\n`);
        }

        // Stream terminator
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        // Non-streaming JSON response
        res.writeHead(200, { "Content-Type": "application/json" });
        const response = createChatResponse(
          payload.messages,
          model,
          false,
          includeTools
        );
        res.end(JSON.stringify(response));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

const PORT = process.env.PROVIDER_PORT ? parseInt(process.env.PROVIDER_PORT) : 19090;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Provider server listening on http://0.0.0.0:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /v1/models");
  console.log("  POST /v1/chat/completions (streaming and non-streaming)");
});
