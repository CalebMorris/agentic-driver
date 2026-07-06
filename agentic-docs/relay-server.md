# Relay Server — Pitfalls and Patterns

Gotchas and correct patterns for `server/src/relay.ts`. Each section is self-contained.

| § | Symptom / Topic |
|---|---------|
| 1 | RelayClient silently drops messages with no matching request ID |
| 2 | Multi-step protocol: collapsing intermediate ACK + late event into one blocking response |
| 3 | Plugin message parser is missing the `id` field in its type annotation |
| 4 | Asserting a relay does NOT forward a message (non-forwarding test) |
| 5 | Plugin disconnect leaves the MCP adapter hanging on a pending request |
| 6 | Relay state resets on plugin disconnect: which variables and why |


## 1. RelayClient only routes messages that have a matching pending request ID

**Background:** `RelayClient.send()` stores a resolver in `pendingRequests` keyed by the outgoing message's `id`. When a WS message arrives, it looks up `response.id` in the map and calls the resolver — then deletes it.

**Consequence:** Any plugin→agent message that lacks an `id`, or whose `id` doesn't match a pending request, is **silently discarded**. This includes:
- Unsolicited events (e.g., `{ type: 'handoff_complete' }` — no `id`)
- Events arriving after the resolver has already been removed

**Design rule:** Every response the MCP adapter needs must arrive as a single message with an `id` that matches the outgoing request. If the protocol defines an intermediate ACK plus a later unsolicited final event, the relay must collapse them (see § 2).

Never try to pass unsolicited events through to the MCP adapter — they will be dropped.


## 2. Multi-step protocol: collapse intermediate ACK + late event into one blocking response

**Problem:** Some actions require two plugin→agent messages:
1. An immediate ACK (e.g., `{ id: "N", type: "result", data: { status: "waiting_for_human" } }`) — has the request ID
2. A later unsolicited completion event (e.g., `{ type: "handoff_complete" }`) — no ID

The MCP adapter's `send()` call blocks on one response. Without relay intervention, it would resolve on the ACK (step 1) and never see the completion event (step 2).

**Fix:** The relay acts as the state machine:

```typescript
// In relay state:
let pendingHandoffId: string | null = null;

// Agent side: detect the action and save the pending ID
if (message.type === 'handoff') {
  pendingHandoffId = message.id ?? '';
}
// ... forward to plugin as normal ...

// Plugin side: suppress the intermediate ACK
if (pendingHandoffId !== null && parsed.id === pendingHandoffId) {
  return; // don't forward waiting_for_human to agent
}

// Plugin side: on the unsolicited final event, synthesize a correlated response
if (parsed.type === 'handoff_complete') {
  if (pendingHandoffId !== null) {
    sendToAgent({ id: pendingHandoffId, type: 'result', data: { status: 'complete' } });
    pendingHandoffId = null;
  }
  return;
}
```

**Result:** From the MCP adapter's perspective, `handoff` is a single `send()` call that blocks until the human is done. No changes needed in `RelayClient` or `server.ts`.

**When to apply:** Any time the protocol defines an action whose true completion signal is an unsolicited later event rather than the immediate plugin response.


## 3. Type-annotate BOTH `type` and `id` in plugin message parsers

**Trap:** The plugin message handler initially typed parsed messages as `{ type?: string }`. When suppressing the intermediate ACK required checking `parsed.id`, TypeScript had no knowledge of `id` and the code required a type change.

**Fix:** From the start, annotate the minimal type for every field the relay may need to inspect:

```typescript
// Plugin socket message handler — CORRECT
let parsed: { type?: string; id?: string };
try {
  parsed = JSON.parse(data.toString());
} catch {
  return;
}

// Agent socket message handler — CORRECT
let message: { id?: string; type?: string };
try {
  message = JSON.parse(data.toString());
} catch {
  return;
}
```

If you later need more fields (e.g., `tabId`, `reason`), add them to the type annotation — don't cast to `any`.


## 4. Testing that the relay does NOT forward a message

**Trap:** Using `waitForMessage(recipientSocket)` to assert non-forwarding hangs the test until timeout, because no message ever arrives.

**Fix:** Register a boolean listener on the recipient socket BEFORE sending the message, yield to let the relay process it, then assert the boolean is still `false`.

```typescript
it('waiting_for_human response is suppressed', async () => {
  // ... setup driving enabled + handoff in flight ...

  let agentReceivedMessage = false;
  agentSocket.on('message', () => { agentReceivedMessage = true; });

  pluginSocket.send(JSON.stringify({ id: '8', type: 'result', data: { status: 'waiting_for_human' } }));
  await waitForRelayProcess(); // yield: 10ms is enough for in-process relay

  expect(agentReceivedMessage).toBe(false);
});
```

**Rule:** Never use `waitForMessage()` when asserting a message was suppressed. Always use the boolean listener pattern + `waitForRelayProcess()`.


## 5. Plugin disconnect while a request is in-flight leaves the MCP adapter hanging

**Trap:** If the plugin disconnects while `pendingHandoffId` (or any similar pending-request variable) is set, the MCP adapter's `relayClient.send()` call blocks indefinitely. The `Promise` stored in `pendingRequests` never resolves because the matching response never arrives.

**Fix:** In the plugin's `close` handler, check every pending-request variable and send an error to the agent to unblock it:

```typescript
socket.on('close', () => {
  pluginSocket = null;
  drivingEnabled = false;
  if (pendingHandoffId !== null) {
    sendErrorToAgent(pendingHandoffId, 'UNKNOWN', 'Plugin disconnected during handoff');
    pendingHandoffId = null;
  }
  logger.info('plugin_disconnected');
});
```

**Rule:** For every `pending*Id` variable the relay introduces, add a corresponding error send + null-clear in the plugin `close` handler.


## 6. Relay state resets on plugin disconnect: checklist

When the plugin socket closes, ALL relay state that implies "plugin is present and trustworthy" must be reset. Currently that means:

| Variable | Reset to | Reason |
|---|---|---|
| `pluginSocket` | `null` | Socket is gone |
| `drivingEnabled` | `false` | Plugin must re-establish driving on reconnect |
| `pendingHandoffId` | `null` | Send error first (§ 5), then clear |

**Rule:** Every time a new piece of relay state is added that depends on the plugin being connected, add its reset to the plugin `close` handler and ask: "if the plugin vanishes right now, what does the agent need to receive to unblock?"
