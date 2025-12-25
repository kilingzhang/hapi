# HAPI WebSocket Protocol Specification

## Overview

This protocol replaces Socket.IO with a custom WebSocket-based protocol that maintains full feature parity while being compatible with Cloudflare Workers/Durable Objects.

## Connection Lifecycle

### 1. Connection Establishment

**Client → Server: WebSocket Upgrade**
```
GET /ws/cli?token=<CLI_API_TOKEN> HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <base64>
Sec-WebSocket-Version: 13
```

**Server → Client: WebSocket Accept**
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: <base64>
```

### 2. Authentication & Initialization

**Client → Server: Auth Message**
```json
{
  "type": "auth",
  "payload": {
    "token": "<CLI_API_TOKEN>",
    "clientType": "session-scoped" | "machine-scoped",
    "sessionId": "<uuid>" | null,
    "machineId": "<uuid>" | null
  }
}
```

**Server → Client: Auth Response**
```json
{
  "type": "auth:ack",
  "payload": {
    "success": true,
    "socketId": "<uuid>",
    "error": null
  }
}
```

or on error:
```json
{
  "type": "auth:ack",
  "payload": {
    "success": false,
    "socketId": null,
    "error": "Invalid token"
  }
}
```

## Message Format

All messages are JSON objects with the following structure:

```typescript
interface Message {
  id: string;           // UUID for request/response matching
  type: string;         // Message type
  payload: unknown;     // Type-specific payload
  timestamp: number;    // Unix timestamp in ms
}
```

## Message Types

### Client → Server Messages

#### 1. RPC Register
```json
{
  "id": "<uuid>",
  "type": "rpc:register",
  "payload": {
    "method": "<sessionId>:git-status"
  },
  "timestamp": 1234567890
}
```

#### 2. RPC Unregister
```json
{
  "id": "<uuid>",
  "type": "rpc:unregister",
  "payload": {
    "method": "<sessionId>:git-status"
  },
  "timestamp": 1234567890
}
```

#### 3. Send Message
```json
{
  "id": "<uuid>",
  "type": "message",
  "payload": {
    "sessionId": "<uuid>",
    "content": { ... },
    "localId": "<uuid>" | null
  },
  "timestamp": 1234567890
}
```

#### 4. Update Metadata
```json
{
  "id": "<uuid>",
  "type": "update-metadata",
  "payload": {
    "sessionId": "<uuid>",
    "expectedVersion": 1,
    "metadata": { ... }
  },
  "timestamp": 1234567890
}
```

#### 5. Update State
```json
{
  "id": "<uuid>",
  "type": "update-state",
  "payload": {
    "sessionId": "<uuid>",
    "expectedVersion": 1,
    "agentState": { ... } | null
  },
  "timestamp": 1234567890
}
```

#### 6. Session Alive (Heartbeat)
```json
{
  "id": "<uuid>",
  "type": "session-alive",
  "payload": {
    "sessionId": "<uuid>",
    "time": 1234567890,
    "thinking": false,
    "mode": "local" | "remote"
  },
  "timestamp": 1234567890
}
```

#### 7. Machine Alive (Heartbeat)
```json
{
  "id": "<uuid>",
  "type": "machine-alive",
  "payload": {
    "machineId": "<uuid>",
    "time": 1234567890
  },
  "timestamp": 1234567890
}
```

#### 8. Ping
```json
{
  "id": "<uuid>",
  "type": "ping",
  "payload": {},
  "timestamp": 1234567890
}
```

### Server → Client Messages

#### 1. RPC Request
```json
{
  "id": "<uuid>",
  "type": "rpc:request",
  "payload": {
    "method": "<sessionId>:git-status",
    "params": "<json-string>"
  },
  "timestamp": 1234567890
}
```

**Client → Server: RPC Response**
```json
{
  "id": "<same-as-request>",
  "type": "rpc:response",
  "payload": {
    "success": true,
    "result": "<json-string>",
    "error": null
  },
  "timestamp": 1234567890
}
```

or on error:
```json
{
  "id": "<same-as-request>",
  "type": "rpc:response",
  "payload": {
    "success": false,
    "result": null,
    "error": "Method not found"
  },
  "timestamp": 1234567890
}
```

#### 2. Update Broadcast
```json
{
  "id": "<uuid>",
  "type": "update",
  "payload": {
    "t": "new-message" | "update-session" | "update-machine",
    "sessionId": "<uuid>" | null,
    "machineId": "<uuid>" | null,
    "data": { ... }
  },
  "timestamp": 1234567890
}
```

#### 3. Update Metadata Response
```json
{
  "id": "<same-as-request>",
  "type": "update-metadata:ack",
  "payload": {
    "result": "success" | "version-mismatch" | "error",
    "version": 2,
    "metadata": { ... } | null
  },
  "timestamp": 1234567890
}
```

#### 4. Update State Response
```json
{
  "id": "<same-as-request>",
  "type": "update-state:ack",
  "payload": {
    "result": "success" | "version-mismatch" | "error",
    "version": 2,
    "agentState": { ... } | null
  },
  "timestamp": 1234567890
}
```

#### 5. Pong
```json
{
  "id": "<same-as-request>",
  "type": "pong",
  "payload": {},
  "timestamp": 1234567890
}
```

## Room Management

Rooms are managed implicitly:
- When a client authenticates with `sessionId`, it's automatically added to room `session:<sessionId>`
- When a client authenticates with `machineId`, it's automatically added to room `machine:<machineId>`
- Broadcasts use the `sessionId` or `machineId` in the update message to route to the correct room

## Error Handling

### Connection Errors
- If authentication fails, server closes WebSocket with code 1008 (Policy Violation)
- If protocol violation occurs, server closes WebSocket with code 1002 (Protocol Error)

### Message Errors
- Invalid message format: Server sends error response with `type: "error"`
- RPC timeout: Server closes connection or sends timeout error

## Timeouts

- RPC request timeout: 30 seconds
- Heartbeat interval: 20 seconds (client sends)
- Connection timeout: 60 seconds without heartbeat

## Reconnection

Client should implement exponential backoff:
- Initial delay: 1 second
- Max delay: 5 seconds
- Max attempts: Infinity

On reconnection:
1. Re-authenticate
2. Re-register all RPC handlers
3. Resume normal operation
