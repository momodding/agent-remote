import * as http from 'node:http';

interface ChatContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ChatContentPart[] | unknown;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: Record<string, unknown>[];
  temperature?: number;
}

interface ChatResponseChoice {
  index: number;
  message?: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  delta?: {
    role?: 'assistant';
    content?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: 'function';
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

interface ChatResponse {
  id: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatResponseChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
  };
}

enum DeterministicScenario {
  PONG = 'PONG',
  TOOL_CALL = 'TOOL_CALL',
  TOOL_FOLLOWUP = 'TOOL_FOLLOWUP',
  ERROR = 'ERROR',
  DEFAULT = 'DEFAULT',
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join(' ');
  }
  return '';
}

function detectScenario(messages: ChatMessage[]): DeterministicScenario {
  const hasToolRole = messages.some((m) => m.role === 'tool');
  const allUserText = messages
    .filter((m) => m.role === 'user')
    .map((m) => extractTextFromContent(m.content).toUpperCase())
    .join(' ');

  if (hasToolRole && allUserText.includes('E2E_TOOL_TEST')) {
    return DeterministicScenario.TOOL_FOLLOWUP;
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? extractTextFromContent(lastUser.content).toUpperCase() : '';

  if (text.includes('E2E_ERROR')) return DeterministicScenario.ERROR;
  if (text.includes('E2E_TOOL_TEST')) return DeterministicScenario.TOOL_CALL;
  if (text.includes('E2E_PING') || text.includes('E2E_PONG')) return DeterministicScenario.PONG;
  return DeterministicScenario.DEFAULT;
}

function getScenarioPayload(
  scenario: DeterministicScenario,
  messages: ChatMessage[]
): {
  text?: string;
  isTool: boolean;
  toolCall?: { id: string; name: string; arguments: string };
} {
  switch (scenario) {
    case DeterministicScenario.PONG:
      return { text: 'E2E_PONG', isTool: false };

    case DeterministicScenario.TOOL_CALL:
      return {
        isTool: true,
        toolCall: {
          id: `call_${Date.now()}`,
          name: 'bash',
          arguments: JSON.stringify({ command: 'echo E2E_TOOL_RESULT' }),
        },
      };

    case DeterministicScenario.TOOL_FOLLOWUP:
      return { text: 'E2E_TOOL_FINAL_OUTPUT', isTool: false };
    case DeterministicScenario.DEFAULT:
    default: {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const userText = lastUser ? extractTextFromContent(lastUser.content) : 'Hello';
      return { text: `Processed: ${userText.slice(0, 50)}`, isTool: false };
    }
  }
}

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
  const bodyBuffer: Buffer[] = [];
  for await (const chunk of req) {
    bodyBuffer.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(bodyBuffer).toString('utf8');

  let parsed: ChatRequest;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Invalid JSON request body', type: 'invalid_request_error', code: 400 },
      })
    );
    return;
  }

  const { model, messages, stream = false } = parsed;
  const isStream = stream === true || stream === ('true' as unknown as boolean);
  const scenario = detectScenario(messages);

  console.log(
    `[Provider] Request: model=${model}, scenario=${scenario}, isStream=${isStream}, messages=${messages.length}`
  );

  // Scenario: E2E_ERROR -> Emit 500 error payload
  if (scenario === DeterministicScenario.ERROR) {
    const errorResp: ErrorResponse = {
      error: {
        message: 'Deterministic E2E simulated model provider error',
        type: 'server_error',
        code: 500,
      },
    };
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResp));
    return;
  }

  const payload = getScenarioPayload(scenario, messages);
  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    if (payload.isTool && payload.toolCall) {
      // Stream tool call chunks
      const chunk1: ChatResponse = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: payload.toolCall.id,
                  type: 'function',
                  function: {
                    name: payload.toolCall.name,
                    arguments: '',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

      const chunk2: ChatResponse = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: payload.toolCall.arguments,
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
    } else {
      // Stream text chunk
      const text = payload.text ?? '';
      const chunk: ChatResponse = {
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: text,
            },
            finish_reason: 'stop',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Non-streaming response
  let choice: ChatResponseChoice;
  if (payload.isTool && payload.toolCall) {
    choice = {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: payload.toolCall.id,
            type: 'function',
            function: {
              name: payload.toolCall.name,
              arguments: payload.toolCall.arguments,
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    };
  } else {
    choice = {
      index: 0,
      message: {
        role: 'assistant',
        content: payload.text ?? '',
      },
      finish_reason: 'stop',
    };
  }

  const response: ChatResponse = {
    id: responseId,
    object: 'chat.completion',
    created,
    model,
    choices: [choice],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20,
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Health check
  if (url.pathname === '/health' || url.pathname === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'deterministic-provider' }));
    return;
  }

  // Models listing
  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'omni-deterministic',
            object: 'model',
            created: 1700000000,
            owned_by: 'e2e-lab',
          },
          {
            id: 'gpt-4o',
            object: 'model',
            created: 1700000000,
            owned_by: 'e2e-lab',
          },
        ],
      })
    );
    return;
  }

  // Chat completions endpoint
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    void handleChatCompletions(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not Found', type: 'not_found_error', code: 404 } }));
});

const PORT = parseInt(process.env.PORT || '19090', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Provider] Deterministic mock LLM server listening on 0.0.0.0:${PORT}`);
});
