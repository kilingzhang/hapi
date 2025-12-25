# HAPI 核心架构深度分析

## 项目核心目的

**在用户本地机器运行AI编码会话（Claude Code/Codex/Gemini），通过远程服务器进行控制和监控**

## 核心业务流程

### 1. 会话启动流程

```
用户运行 `hapi` 命令
    ↓
CLI创建Session（通过REST API）
    ↓
CLI启动Claude进程（本地或远程模式）
    ↓
CLI通过Socket.IO连接到Server
    ↓
CLI注册RPC处理器（git操作、文件读取等）
    ↓
会话就绪，等待用户操作
```

### 2. 用户操作流程（Web界面）

```
用户在Web界面点击"查看Git状态"
    ↓
Web发送 REST API: GET /api/sessions/:id/git-status
    ↓
Server的SyncEngine.getGitStatus()
    ↓
通过Socket.IO RPC调用: sessionRpc(sessionId, 'git-status', { cwd })
    ↓
RpcRegistry查找方法对应的socketId
    ↓
通过Socket.IO发送: socket.emitWithAck('rpc-request', { method, params })
    ↓
CLI的RpcHandlerManager处理请求
    ↓
执行git status命令
    ↓
返回结果给Server
    ↓
Server返回给Web界面
```

### 3. 消息流

```
CLI发送消息
    ↓
Socket.IO: socket.emit('message', { sid, message })
    ↓
Server存储到SQLite
    ↓
Server广播: socket.to(`session:${sid}`).emit('update', update)
    ↓
SSE推送到Web界面
```

### 4. 权限审批流程

```
Claude请求权限（如文件写入）
    ↓
CLI更新AgentState（通过Socket.IO）
    ↓
Server存储到SQLite并广播
    ↓
Web界面显示权限请求
    ↓
用户点击"批准"
    ↓
REST API: POST /api/sessions/:id/permissions/:requestId/approve
    ↓
Server通过RPC调用: sessionRpc('permission', { approved: true })
    ↓
CLI的PermissionHandler处理
    ↓
Claude继续执行
```

## 核心模块分析

### 1. RPC机制（最关键！）

**目的**：Server主动调用CLI的方法

**实现**：
```typescript
// Server端
private async rpcCall(method: string, params: unknown): Promise<unknown> {
    const socketId = this.rpcRegistry.getSocketIdForMethod(method)
    const socket = this.io.of('/cli').sockets.get(socketId)
    const response = await socket.timeout(30_000).emitWithAck('rpc-request', {
        method,
        params: JSON.stringify(params)
    })
    return JSON.parse(response)
}

// CLI端
this.socket.on('rpc-request', async (data, callback) => {
    const result = await this.rpcHandlerManager.handleRequest(data)
    callback(result)
})
```

**关键特性**：
- 请求-响应模式（emitWithAck）
- 30秒超时
- 方法注册机制（rpc-register）
- 方法到socketId的映射

**RPC方法类型**：
- Git操作：`git-status`, `git-diff-numstat`, `git-diff-file`
- 文件操作：`readFile`, `writeFile`, `listDirectory`
- 命令执行：`bash`
- 搜索：`ripgrep`
- 权限：`permission`
- 控制：`abort`, `switch`

### 2. 消息同步机制

**目的**：CLI和Web界面之间的消息同步

**实现**：
```typescript
// CLI发送消息
socket.emit('message', { sid, message, localId })

// Server处理
const msg = store.addMessage(sid, content, localId)
socket.to(`session:${sid}`).emit('update', update)
sseManager.broadcast({ type: 'message-received', sessionId: sid, message: msg })
```

**关键特性**：
- 消息存储到SQLite
- Socket.IO房间广播（socket.to）
- SSE实时推送
- 消息分页查询

### 3. 状态同步机制

**目的**：会话状态、Agent状态的实时同步

**实现**：
```typescript
// CLI更新状态
socket.emitWithAck('update-metadata', { sid, expectedVersion, metadata })

// Server处理（版本控制）
const result = store.updateSessionMetadata(sid, metadata, expectedVersion)
if (result.result === 'success') {
    socket.to(`session:${sid}`).emit('update', update)
}
```

**关键特性**：
- 乐观锁（版本控制）
- 版本冲突处理
- 广播更新

### 4. 房间机制

**目的**：将连接分组，实现定向广播

**实现**：
```typescript
// 连接时加入房间
socket.join(`session:${sessionId}`)
socket.join(`machine:${machineId}`)

// 广播到房间
socket.to(`session:${sessionId}`).emit('update', update)
```

**关键特性**：
- 基于sessionId的房间
- 基于machineId的房间
- 多房间支持

### 5. 心跳保活机制

**目的**：保持连接活跃，检测连接状态

**实现**：
```typescript
// CLI发送心跳
setInterval(() => {
    socket.volatile.emit('session-alive', { sid, time, thinking, mode })
}, 20000)

// Server处理
onSessionAlive({ sid, time, thinking, mode }) {
    session.active = true
    session.activeAt = Math.max(session.activeAt, time)
    session.thinking = thinking
}
```

**关键特性**：
- 20秒间隔
- volatile发送（不保证送达）
- 超时检测（30秒无心跳则标记为inactive）

## 数据流图

```
┌─────────────┐
│   Web UI    │
└──────┬──────┘
       │ REST API + SSE
       ↓
┌─────────────────────────────────┐
│         Server                  │
│  ┌──────────────────────────┐  │
│  │    SyncEngine            │  │
│  │  - 内存状态缓存          │  │
│  │  - RPC调用               │  │
│  │  - 消息广播              │  │
│  └──────────┬───────────────┘  │
│             │                   │
│  ┌──────────▼───────────────┐  │
│  │    Socket.IO Server      │  │
│  │  - 连接管理              │  │
│  │  - 房间管理              │  │
│  │  - RPC路由               │  │
│  └──────────┬───────────────┘  │
│             │                   │
│  ┌──────────▼───────────────┐  │
│  │    Store (SQLite)        │  │
│  │  - Sessions              │  │
│  │  - Messages               │  │
│  │  - Machines               │  │
│  └──────────────────────────┘  │
└─────────────┬───────────────────┘
              │ Socket.IO
              ↓
┌─────────────────────────────────┐
│         CLI                     │
│  ┌──────────────────────────┐  │
│  │  ApiSessionClient        │  │
│  │  - Socket.IO连接         │  │
│  │  - RPC注册               │  │
│  │  - 消息发送              │  │
│  └──────────┬───────────────┘  │
│             │                   │
│  ┌──────────▼───────────────┐  │
│  │  RpcHandlerManager       │  │
│  │  - Git操作               │  │
│  │  - 文件操作              │  │
│  │  - 命令执行              │  │
│  └──────────┬───────────────┘  │
│             │                   │
│  ┌──────────▼───────────────┐  │
│  │  Claude Process          │  │
│  │  - AI编码会话            │  │
│  └──────────────────────────┘  │
└─────────────────────────────────┘
```

## 关键依赖分析

### Socket.IO的关键功能

1. **emitWithAck** - RPC调用的核心
   - 请求-响应模式
   - 超时支持
   - 回调机制

2. **房间机制** - 广播的核心
   - socket.join()
   - socket.to()
   - 多房间支持

3. **长连接** - 实时通信的基础
   - 自动重连
   - 连接状态管理
   - 心跳保活

4. **命名空间** - 连接隔离
   - `/cli` 命名空间
   - 认证中间件

## 迁移到Workers的挑战

### 1. RPC机制
- ✅ 可以实现：使用WebSocket + 请求ID匹配
- ⚠️ 复杂度：需要实现请求-响应匹配机制
- ⚠️ 超时：30秒超时需要Durable Objects支持

### 2. 房间机制
- ✅ 可以实现：在Durable Objects中管理房间
- ⚠️ 复杂度：需要自己实现房间路由
- ⚠️ 性能：跨DO的广播可能有延迟

### 3. 状态管理
- ✅ 可以实现：Durable Objects + D1
- ⚠️ 一致性：D1是最终一致性
- ⚠️ 缓存：内存缓存需要重新设计

### 4. 连接管理
- ✅ 可以实现：ConnectionManagerDO
- ⚠️ 限制：每个DO最多1000连接
- ⚠️ Sharding：需要连接分片策略

## 结论

**核心是RPC机制**：Server主动调用CLI的方法，这是整个系统的核心功能。

迁移到Workers是**可行的**，但需要：
1. 实现完整的RPC机制（请求-响应匹配）
2. 实现房间机制（广播路由）
3. 处理状态一致性（D1 + DO缓存）
4. 处理连接限制（Sharding策略）
