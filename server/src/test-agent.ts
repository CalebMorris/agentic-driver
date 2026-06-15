import { WebSocket } from 'ws';

const socket = new WebSocket('ws://localhost:9999/agent');

socket.on('open', () => {
  console.log('[test-agent] Connected to relay server');
  const message = { id: '1', type: 'read_html' };
  console.log('[test-agent] Sending:', JSON.stringify(message));
  socket.send(JSON.stringify(message));
});

socket.on('message', (data) => {
  const response = JSON.parse(data.toString()) as unknown;
  console.log('[test-agent] Received:', JSON.stringify(response, null, 2));
  socket.close();
});

socket.on('error', (error) => {
  console.error('[test-agent] Error:', error.message);
  process.exit(1);
});
