# Claude会话启动逻辑的控制机制深度分析

## 核心控制架构

```
runClaude()
    ↓
创建Session和ApiSessionClient
    ↓
启动HAPI MCP Server和Hook Server
    ↓
设置初始状态 (controlledByUser)
    ↓
创建消息队列 (MessageQueue2)
    ↓
注册用户消息处理器
    ↓
进入循环: runLocalRemoteLoop()
    ├── Local模式: claudeLocalLauncher()
    │   └── 启动Claude本地进程
    │   └── 注册RPC处理器 (abort, switch)
    │   └── 监听消息队列
    │   └── 收到消息/远程控制 → 切换到Remote模式
    │
    └── Remote模式: claudeRemoteLauncher()
        └── 启动Claude远程SDK
        └── 注册RPC处理器 (abort, switch)
        └── 处理权限请求
        └── 处理消息队列
        └── 完成/切换 → 切换到Local模式
```

## 1. 双模式控制机制

### Local模式 vs Remote模式

**Local模式** (`claudeLocalLauncher`):
- Claude进程在本地运行，用户可以直接交互
- 使用 `claudeLocal()` 启动Claude CLI进程
- 通过 `sessionScanner` 扫描Claude输出
- **控制特点**：用户直接控制，收到远程消息时切换到Remote模式

**Remote模式** (`claudeRemoteLauncher`):
- Claude通过SDK远程调用，完全由Server控制
- 使用 `claudeRemote()` 启动Claude SDK
- 通过 `PermissionHandler` 处理权限请求
- **控制特点**：Server完全控制，处理完消息后切换到Local模式

### 模式切换逻辑 (`runLocalRemoteLoop`)

```typescript
while (true) {
    if (mode === 'local') {
        const reason = await runLocal(session);
        if (reason === 'exit') return;
        mode = 'remote';  // 切换到Remote模式
        session.onModeChange(mode);
        continue;
    }
    
    if (mode === 'remote') {
        const reason = await runRemote(session);
        if (reason === 'exit') return;
        mode = 'local';  // 切换到Local模式
        session.onModeChange(mode);
        continue;
    }
}
```

**切换触发条件**：
- Local → Remote: 收到远程消息、用户点击切换、RPC调用switch
- Remote → Local: 消息处理完成、用户点击切换、RPC调用switch

## 2. RPC控制机制

### RPC处理器注册

**Local模式注册的RPC处理器**：
```typescript
// 中止当前进程，清理队列，切换到Remote模式
session.client.rpcHandlerManager.registerHandler('abort', doAbort);

// 切换到Remote模式
session.client.rpcHandlerManager.registerHandler('switch', doSwitch);

// 收到任何消息时切换到Remote模式
session.queue.setOnMessage((message, mode) => {
    doSwitch();
});
```

**Remote模式注册的RPC处理器**：
```typescript
// 中止当前会话
session.client.rpcHandlerManager.registerHandler('abort', doAbort);

// 切换到Local模式
session.client.rpcHandlerManager.registerHandler('switch', doSwitch);
```

### RPC调用流程

```
Web界面点击"切换到Remote模式"
    ↓
REST API: POST /api/sessions/:id/switch
    ↓
Server: SyncEngine.switchSession()
    ↓
Socket.IO RPC: sessionRpc('switch', { to: 'remote' })
    ↓
CLI: RpcHandlerManager.handleRequest('switch')
    ↓
执行: doSwitch() → exitReason = 'switch'
    ↓
退出当前模式循环
    ↓
runLocalRemoteLoop切换到另一个模式
```

## 3. 状态控制机制

### controlledByUser状态

```typescript
// 初始化状态
session.updateAgentState((currentState) => ({
    ...currentState,
    controlledByUser: options.startingMode !== 'remote'
}));

// 模式切换时更新
onModeChange: (newMode) => {
    session.sendSessionEvent({ type: 'switch', mode: newMode });
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: newMode === 'local'
    }));
}
```

**状态含义**：
- `controlledByUser: true` → Local模式，用户直接控制
- `controlledByUser: false` → Remote模式，Server控制

### AgentState同步

```typescript
// CLI更新状态
session.updateAgentState((currentState) => ({
    ...currentState,
    controlledByUser: newMode === 'local'
}));

// 通过Socket.IO发送到Server
socket.emitWithAck('update-state', {
    sid: sessionId,
    expectedVersion: agentStateVersion,
    agentState: updated
});

// Server存储并广播
store.updateSessionAgentState(sid, agentState, expectedVersion)
socket.to(`session:${sid}`).emit('update', update)
```

## 4. 消息队列控制

### MessageQueue2机制

```typescript
const messageQueue = new MessageQueue2<EnhancedMode>(
    mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        // ...
    })
);
```

**消息处理流程**：

```
用户发送消息 (Web/Telegram)
    ↓
Server: SyncEngine.sendMessage()
    ↓
Socket.IO: socket.to(`session:${sid}`).emit('update', update)
    ↓
CLI: session.onUserMessage((message) => { ... })
    ↓
解析消息元数据 (permissionMode, model, etc.)
    ↓
推送到消息队列: messageQueue.push(text, enhancedMode)
    ↓
Local模式: 收到消息 → 切换到Remote模式
Remote模式: 处理消息队列 → Claude执行 → 完成后切换到Local模式
```

### 特殊命令处理

```typescript
const specialCommand = parseSpecialCommand(message.content.text);

if (specialCommand.type === 'compact') {
    // 隔离并清空队列，只处理这条消息
    messageQueue.pushIsolateAndClear(specialCommand.originalMessage, enhancedMode);
    return;
}

if (specialCommand.type === 'clear') {
    // 清空队列，重新开始
    messageQueue.pushIsolateAndClear(specialCommand.originalMessage, enhancedMode);
    return;
}
```

## 5. 权限控制机制

### PermissionHandler (Remote模式)

```typescript
const permissionHandler = new PermissionHandler(session);

// 监听权限请求
permissionHandler.setOnPermissionRequest((toolCallId) => {
    messageQueue.releaseToolCall(toolCallId);
});

// 处理权限响应
permissionHandler.getResponses() // 返回权限决策结果
```

**权限流程**：

```
Claude请求权限 (文件写入等)
    ↓
Remote模式检测到权限请求
    ↓
更新AgentState.requests
    ↓
通过Socket.IO发送到Server
    ↓
Server广播到Web界面
    ↓
用户点击"批准"
    ↓
REST API: POST /api/sessions/:id/permissions/:requestId/approve
    ↓
Server RPC调用: sessionRpc('permission', { approved: true })
    ↓
CLI PermissionHandler处理
    ↓
Claude继续执行
```

## 6. 进程控制机制

### Local模式进程控制

```typescript
const processAbortController = new AbortController();

// 启动Claude进程
await claudeLocal({
    abort: processAbortController.signal,
    // ...
});

// 中止进程
async function doAbort() {
    if (!processAbortController.signal.aborted) {
        processAbortController.abort();
    }
    await exitFuture.promise;
}
```

### Remote模式SDK控制

```typescript
const abortController = new AbortController();

// 启动Claude SDK
await claudeRemote({
    abort: abortController.signal,
    // ...
});

// 中止SDK
async function doAbort() {
    if (abortController && !abortController.signal.aborted) {
        abortController.abort();
    }
    await abortFuture?.promise;
}
```

## 7. 生命周期控制

### 启动流程

```typescript
1. 创建Session和ApiSessionClient
2. 启动HAPI MCP Server (提供工具)
3. 启动Hook Server (接收Claude通知)
4. 设置初始状态 (controlledByUser)
5. 创建消息队列
6. 注册用户消息处理器
7. 进入循环 (runLocalRemoteLoop)
```

### 关闭流程

```typescript
// 信号处理
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

async function cleanup() {
    // 更新生命周期状态
    session.updateMetadata({
        lifecycleState: 'archived',
        archivedBy: 'cli',
        archiveReason: 'User terminated'
    });
    
    // 发送会话死亡消息
    session.sendSessionDeath();
    
    // 等待Socket刷新
    await session.flush();
    
    // 关闭连接
    await session.close();
    
    // 停止服务器
    happyServer.stop();
    hookServer.stop();
    
    // 清理文件
    cleanupHookSettingsFile(hookSettingsPath);
}
```

## 8. 关键控制点总结

### 控制入口

1. **命令行参数**: `startingMode`, `permissionMode`, `model`
2. **RPC调用**: `abort`, `switch`, `permission`
3. **消息队列**: 用户消息触发模式切换
4. **状态同步**: `controlledByUser` 控制权限

### 控制流程

```
外部控制 (Web/Telegram)
    ↓
REST API / Socket.IO RPC
    ↓
CLI RPC处理器
    ↓
模式切换 / 状态更新
    ↓
Claude进程控制
    ↓
执行结果反馈
```

## 9. 关键代码位置

- **模式切换**: `cli/src/agent/loopBase.ts` - `runLocalRemoteLoop`
- **Local启动**: `cli/src/claude/claudeLocalLauncher.ts`
- **Remote启动**: `cli/src/claude/claudeRemoteLauncher.ts`
- **RPC注册**: `cli/src/claude/claudeLocalLauncher.ts:71-76`
- **状态更新**: `cli/src/claude/runClaude.ts:159-162, 372-377`
- **消息处理**: `cli/src/claude/runClaude.ts:183-308`
- **权限处理**: `cli/src/claude/claudeRemoteLauncher.ts:100-117`

## 10. 控制机制特点

1. **双模式设计**: Local和Remote模式无缝切换
2. **RPC驱动**: 所有控制通过RPC机制实现
3. **状态同步**: 实时同步控制状态到Server
4. **消息驱动**: 消息队列驱动模式切换
5. **权限控制**: 细粒度的权限审批机制
6. **生命周期管理**: 完整的启动和关闭流程
