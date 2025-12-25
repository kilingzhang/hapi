# CRDT-based 文件同步方案

## 什么是 CRDT？

CRDT (Conflict-free Replicated Data Type) 是一种数据结构，允许多个副本独立修改并自动合并，**无需手动解决冲突**。

### 为什么适合文件同步？

- ✅ **无冲突合并**：两端同时编辑也能自动合并
- ✅ **操作级同步**：同步的是操作（插入/删除），不只是文件内容
- ✅ **最终一致性**：最终所有副本都会一致
- ✅ **实时性**：操作立即同步

## 架构

```
本地文件系统 ←→ CRDT 文档 ←→ WebSocket ←→ CRDT 文档 ←→ 远端文件系统
```

## 使用方法

### 1. 安装依赖

```bash
cd crdt-sync
bun install
```

### 2. 启动同步服务器（可选，如果使用 WebSocket）

```bash
bun run server.ts
```

### 3. 在本地启动同步客户端

```bash
bun run client.ts --dir=/path/to/sync --server=ws://localhost:1234
```

### 4. 在远端启动同步客户端

```bash
bun run client.ts --dir=/path/to/sync --server=ws://your-server:1234
```

## 工作原理

1. **文件系统监听**：监听本地文件变化
2. **CRDT 同步**：将文件内容转换为 CRDT 文档
3. **操作同步**：通过 WebSocket 同步操作（不是整个文件）
4. **自动合并**：CRDT 自动处理冲突
5. **写回文件**：将合并后的内容写回文件系统

## 示例场景

**场景 1：两端同时编辑不同行**
- 本地：在第 10 行添加 `console.log('local')`
- 远端：在第 20 行添加 `console.log('remote')`
- **结果**：自动合并，两行都保留 ✅

**场景 2：两端同时编辑同一行**
- 本地：`const x = 1`
- 远端：`const x = 2`
- **结果**：CRDT 会根据操作顺序自动合并（最后写入获胜或智能合并）

## 技术栈

- **Yjs**：成熟的 CRDT 库
- **WebSocket**：实时通信
- **chokidar**：文件系统监听
