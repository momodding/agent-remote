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
      index: number;
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
  TOOL_TEST = 'TOOL_TEST',
  SLOW = 'SLOW',
  ERROR = 'ERROR',
  UNICODE = 'UNICODE',
  LARGE = 'LARGE',
  NORMAL = 'NORMAL',
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : ((c as ChatContentPart)?.text || ''))).join(' ');
  }
  return String(content || '');
}

function detectScenario(messages: ChatMessage[]): DeterministicScenario {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content;
  const text = extractTextFromContent(lastUserMsg).toUpperCase();

  if (text.includes('E2E_PONG')) return DeterministicScenario.PONG;
  if (text.includes('E2E_TOOL_TEST')) return DeterministicScenario.TOOL_TEST;
  if (text.includes('E2E_SLOW')) return DeterministicScenario.SLOW;
  if (text.includes('E2E_ERROR')) return DeterministicScenario.ERROR;
  if (text.includes('UNICODE')) return DeterministicScenario.UNICODE;
  if (text.includes('LARGE')) return DeterministicScenario.LARGE;
  return DeterministicScenario.NORMAL;
}

function getScenarioPayload(scenario: DeterministicScenario, messages: ChatMessage[]): { text: string; isTool: boolean } {
  switch (scenario) {
    case DeterministicScenario.PONG:
      return { text: 'E2E_PONG', isTool: false };

    case DeterministicScenario.TOOL_TEST:
      return { text: '', isTool: true };

    case DeterministicScenario.SLOW:
      return { text: 'This is a delayed response verifying streaming backpressure and latency.', isTool: false };

    case DeterministicScenario.UNICODE:
      return {
        text: 'Hello 🚀 🌍 \u{1F600} \u{4E2D}\u{6587} \u{3053}\u{3093}\u{306B}\u{3061}\u{306F} \u{041F}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442} \u{2728} \u{00E9}\u{00E8}\u{00E0}\u{00F9}\u{00E7}',
        isTool: false,
      };

    case DeterministicScenario.LARGE:
      // Generate deterministic ~36KB payload
      const chunk = 'Deterministic large payload block for buffering and chunked transfer validation. ';
      return { text: chunk.repeat(450), isTool: false };

    case DeterministicScenario.NORMAL:
    default:
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content;
      const userText = extractTextFromContent(lastUser) || 'Hello';
      return { text: `Hermetic response to: "${userText}" (verified deterministic OMP upstream turn).`, isTool: false };
  }
}

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const bodyText = Buffer.concat(chunks).toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON request body', type: 'invalid_request_error', code: 400 } }));
    return;
  }

  const reqBody = parsed as Partial<ChatRequest>;
  const messages: ChatMessage[] = Array.isArray(reqBody.messages) ? reqBody.messages : [];
  const model = typeof reqBody.model === 'string' ? reqBody.model : 'omni-deterministic';
  const isStream = Boolean(reqBody.stream);

  const scenario = detectScenario(messages);

  // Scenario: E2E_ERROR -> Emit 500 error payload
  if (scenario === DeterministicScenario.ERROR) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    const errObj: ErrorResponse = {
      error: {
        message: 'Simulated upstream error for scenario E2E_ERROR',
        type: 'server_error',
        code: 500,
      },
    };
    res.end(JSON.stringify(errObj));
    return;
  }

  const { text, isTool } = getScenarioPayload(scenario, messages);

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const completionId = `chatcmpl-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);

    if (isTool) {
      const toolChunk: ChatResponse = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now()}`,
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: JSON.stringify({ location: 'San Francisco, CA' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
    } else {
      const words = text.split(' ');
      for (let i = 0; i < words.length; i++) {
        if (scenario === DeterministicScenario.SLOW) {
          await new Promise((r) => setTimeout(r, 50));
        }

        const isLast = i === words.length - 1;
        const chunkObj: ChatResponse = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model,
          choices: [
            {
              index: 0,
              delta: {
                content: i === 0 ? words[i] : ` ${words[i]}`,
              },
              finish_reason: isLast ? 'stop' : null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunkObj)}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    // Non-streaming JSON response
    if (scenario === DeterministicScenario.SLOW) {
      await new Promise((r) => setTimeout(r, 300));
    }

    const respObj: ChatResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: isTool
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call_${Date.now()}`,
                    type: 'function',
                    function: {
                      name: 'get_weather',
                      arguments: JSON.stringify({ location: 'San Francisco, CA' }),
                    },
                  },
                ],
              }
            : {
                role: 'assistant',
                content: text,
              },
          finish_reason: isTool ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: 15,
        completion_tokens: text.length > 0 ? text.split(' ').length : 10,
        total_tokens: 25,
      },
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(respObj));
  }
}

function handleModels(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const models = {
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
  };
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(models));
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const url = req.url || '/';

  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    handleModels(req, res);
    return;
  }

  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    handleChatCompletions(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: msg, type: 'internal_error', code: 500 } }));
    });
    return;
  }

  if (url === '/healthz' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', provider: 'deterministic-e2e-provider' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Not Found: ${url}`, type: 'not_found', code: 404 } }));
});

const PORT = Number(process.env.PROVIDER_PORT || 19090);
if (import.meta.main) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Deterministic Provider] Listening on http://0.0.0.0:${PORT}`);
  });
}
