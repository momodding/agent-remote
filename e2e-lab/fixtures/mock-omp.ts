import * as http from 'node:http';

export interface MockOMPOptions {
  port?: number;
  thinkingDelayMs?: number;
  responseChunks?: string[];
}

export class MockOpenAIServer {
  private server: http.Server | null = null;
  public port: number;
  public requests: Array<{ url: string; body: unknown }> = [];

  constructor(port = 18080) {
    this.port = port;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        let bodyStr = '';
        req.on('data', (chunk) => {
          bodyStr += chunk;
        });

        req.on('end', () => {
          let parsed: unknown = {};
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            parsed = bodyStr;
          }
          this.requests.push({ url: req.url || '', body: parsed });

          if (req.url === '/v1/chat/completions') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });

            // Stream reasoning/thinking chunk
            const chunk1 = {
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: Date.now(),
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', reasoning_content: 'Analyzing repository structure and plans...' },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

            // Stream content chunk
            const chunk2 = {
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: Date.now(),
              model: 'gpt-4o',
              choices: [
                {
                  index: 0,
                  delta: { content: 'I have verified the E2E architecture.' },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(chunk2)}\n\n`);

            // Stream finish
            const chunkEnd = {
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: Date.now(),
              model: 'gpt-4o',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            res.write(`data: ${JSON.stringify(chunkEnd)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          if (req.url === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                object: 'list',
                data: [{ id: 'gpt-4o', object: 'model', created: 1700000000, owned_by: 'openai' }],
              })
            );
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
