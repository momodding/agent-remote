import { createConnection, createServer } from 'node:net';

const port = Number(process.env.DAEMON_FORWARD_PORT || '18766');
const host = process.env.DAEMON_FORWARD_HOST;
const targetPort = Number(process.env.DAEMON_FORWARD_TARGET_PORT || '18765');

if (!host) throw new Error('DAEMON_FORWARD_HOST is required');

const server = createServer((client) => {
  const upstream = createConnection({ host, port: targetPort });
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});

server.listen({ host: '127.0.0.1', port }, () => {
  console.log(`Daemon TCP forwarder listening on 127.0.0.1:${port} -> ${host}:${targetPort}`);
});
