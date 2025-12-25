# Cloudflare Workers Migration Plan

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│              Cloudflare Workers Layer                   │
├─────────────────────────────────────────────────────────┤
│  Worker (Stateless)                                      │
│  - REST API (Hono)                                      │
│  - SSE Endpoints                                        │
│  - WebSocket Upgrade Handler                            │
│  - Static Assets (R2)                                   │
└──────────────┬──────────────────────────────────────────┘
               │
               │ Durable Objects API
               │
┌──────────────▼──────────────────────────────────────────┐
│         Durable Objects (Stateful)                      │
├─────────────────────────────────────────────────────────┤
│  1. ConnectionManagerDO                                 │
│     - Manages WebSocket connections                     │
│     - Routes messages to sessions/machines              │
│     - Handles authentication                            │
│                                                          │
│  2. SessionManagerDO                                    │
│     - Manages session state                             │
│     - Handles RPC registry                              │
│     - Broadcasts updates                                │
│                                                          │
│  3. RpcRegistryDO                                       │
│     - Maps RPC methods to connections                  │
│     - Handles RPC request/response                     │
└──────────────┬──────────────────────────────────────────┘
               │
               │ D1 Database
               │
┌──────────────▼──────────────────────────────────────────┐
│              D1 Database                                │
│  - Sessions                                             │
│  - Messages                                             │
│  - Machines                                             │
└──────────────────────────────────────────────────────────┘
```

## Migration Steps

### Phase 1: Protocol Design ✅
- [x] Design WebSocket protocol specification
- [x] Document message types and formats

### Phase 2: D1 Database Migration
- [ ] Create D1 schema (same as SQLite)
- [ ] Migrate Store class to use D1
- [ ] Test data operations

### Phase 3: Durable Objects Implementation
- [ ] Implement ConnectionManagerDO
- [ ] Implement SessionManagerDO  
- [ ] Implement RpcRegistryDO
- [ ] Implement room/broadcast mechanism

### Phase 4: Worker Implementation
- [ ] Migrate REST API to Worker
- [ ] Migrate SSE to Worker
- [ ] Implement WebSocket upgrade handler
- [ ] Integrate with Durable Objects

### Phase 5: CLI Client Migration
- [ ] Replace socket.io-client with WebSocket
- [ ] Implement protocol client
- [ ] Implement reconnection logic
- [ ] Test all RPC handlers

### Phase 6: Testing & Validation
- [ ] End-to-end testing
- [ ] Performance testing
- [ ] Load testing
- [ ] Migration validation

## Key Implementation Details

### 1. Durable Objects ID Strategy

```typescript
// ConnectionManagerDO: One per connection
const connectionId = `connection:${socketId}`

// SessionManagerDO: One per session
const sessionId = `session:${sessionId}`

// RpcRegistryDO: Global singleton
const registryId = 'rpc-registry:global'
```

### 2. WebSocket Connection Flow

```
1. Client opens WebSocket to Worker
2. Worker upgrades connection
3. Worker routes to ConnectionManagerDO
4. ConnectionManagerDO authenticates
5. ConnectionManagerDO joins SessionManagerDO
6. SessionManagerDO registers with RpcRegistryDO
```

### 3. RPC Call Flow

```
1. REST API receives RPC request
2. Worker queries RpcRegistryDO for method
3. RpcRegistryDO returns connectionId
4. Worker routes to ConnectionManagerDO
5. ConnectionManagerDO sends RPC request via WebSocket
6. Client responds via WebSocket
7. ConnectionManagerDO returns response to Worker
8. Worker returns to REST API
```

### 4. Broadcast Flow

```
1. SessionManagerDO receives update
2. SessionManagerDO queries ConnectionManagerDO for room members
3. SessionManagerDO broadcasts to all connections in room
4. ConnectionManagerDO sends WebSocket messages
```

## Performance Considerations

### Connection Limits
- Durable Objects: 1000 concurrent connections per object
- Solution: Shard ConnectionManagerDO by connection hash

### RPC Timeout
- Durable Objects support long-running operations
- 30-second timeout is acceptable

### Database Queries
- D1 has query limits
- Use batching where possible
- Cache frequently accessed data in Durable Objects

## Cost Estimation

### Free Tier
- Workers: 100,000 requests/day
- Durable Objects: 400,000 GB-seconds/month
- D1: 5GB storage, 5M reads/month

### Paid Tier (if needed)
- Workers: $5/month + $0.50 per million requests
- Durable Objects: $0.15 per million requests
- D1: $0.001 per GB/month + $0.001 per million reads

## Risks & Mitigations

### Risk 1: Durable Objects Cold Start
- Mitigation: Keep-alive mechanism, warm connections

### Risk 2: Connection Limits
- Mitigation: Sharding, connection pooling

### Risk 3: Protocol Compatibility
- Mitigation: Comprehensive testing, version negotiation

### Risk 4: Data Migration
- Mitigation: Dual-write period, gradual migration

## Testing Strategy

1. **Unit Tests**: Each component in isolation
2. **Integration Tests**: Durable Objects + D1
3. **E2E Tests**: Full flow from CLI to Worker
4. **Load Tests**: Simulate multiple concurrent connections
5. **Migration Tests**: Validate data consistency
