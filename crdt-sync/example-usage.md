# CRDT 文件同步使用示例

## 快速开始

### 1. 安装依赖

```bash
cd crdt-sync
bun install
```

### 2. 启动同步服务器（在一个终端）

```bash
bun run server.ts
```

输出：
```
[Server] CRDT 同步服务器启动在端口 1234
[Server] WebSocket 地址: ws://localhost:1234
```

### 3. 在本地启动客户端（在另一个终端）

```bash
# 同步当前目录
bun run client.ts --dir=/path/to/your/project

# 或指定服务器地址
bun run client.ts --dir=/path/to/your/project --server=ws://your-server:1234
```

### 4. 在远端启动客户端

```bash
# 在远端机器上运行相同的命令
bun run client.ts --dir=/path/to/same/project --server=ws://your-server:1234
```

## 测试场景

### 场景 1：两端同时编辑不同行

**本地操作：**
```typescript
// 在文件 test.ts 第 10 行添加
console.log('local edit')
```

**远端操作：**
```typescript
// 在文件 test.ts 第 20 行添加
console.log('remote edit')
```

**结果：** 两行都会自动合并到文件中 ✅

### 场景 2：两端同时编辑同一区域

**本地操作：**
```typescript
const x = 1  // 修改为 1
```

**远端操作：**
```typescript
const x = 2  // 修改为 2
```

**结果：** CRDT 会根据操作的时间戳和顺序自动合并（最后写入获胜或智能合并）

### 场景 3：文件创建和删除

**本地操作：**
```bash
touch new-file.ts
```

**远端操作：**
```bash
rm old-file.ts
```

**结果：** 文件创建和删除都会同步 ✅

## 工作原理详解

### CRDT 如何避免冲突？

1. **操作标识**：每个操作都有唯一标识符（基于时间戳和客户端 ID）
2. **操作顺序**：CRDT 使用向量时钟（Vector Clock）确定操作顺序
3. **自动合并**：相同位置的操作会根据规则自动合并

### 示例：两个客户端同时编辑

```
初始状态: "Hello World"

客户端 A (本地): 在位置 5 插入 "Beautiful "
操作: insert(5, "Beautiful ")
结果: "Hello Beautiful World"

客户端 B (远端): 在位置 11 插入 "!"
操作: insert(11, "!")
结果: "Hello World!"

合并后: "Hello Beautiful World!"
```

CRDT 会自动调整位置，确保两个插入操作都生效。

## 高级配置

### 只同步特定文件类型

修改 `client.ts` 中的 `isTextFile` 函数：

```typescript
function isTextFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase()
    // 只同步 TypeScript 文件
    return ext === '.ts' || ext === '.tsx'
}
```

### 使用不同的传输协议

除了 WebSocket，Yjs 还支持：
- **HTTP**：`y-http`
- **WebRTC**：`y-webrtc`（P2P，无需服务器）
- **IndexedDB**：`y-indexeddb`（浏览器本地存储）

### 使用 WebRTC（无需服务器）

```typescript
import { WebrtcProvider } from 'y-webrtc'

const provider = new WebrtcProvider(roomName, ydoc, {
    signaling: ['wss://signaling-server.com']
})
```

## 性能考虑

- **操作级同步**：只同步变更的操作，不是整个文件
- **增量更新**：CRDT 文档支持增量更新
- **压缩**：Yjs 支持操作压缩，减少网络传输

## 限制和注意事项

1. **二进制文件**：CRDT 主要适用于文本文件，二进制文件需要特殊处理
2. **大文件**：非常大的文件（>10MB）可能需要优化
3. **网络延迟**：高延迟环境下，合并可能需要时间
4. **文件权限**：确保两端都有文件读写权限

## 故障排查

### 连接失败

```bash
# 检查服务器是否运行
curl http://localhost:1234

# 检查防火墙
netstat -an | grep 1234
```

### 文件不同步

1. 检查文件是否在忽略列表中
2. 检查文件类型是否被支持
3. 查看客户端日志输出

### 冲突处理

CRDT 理论上不会产生冲突，但如果出现不一致：
1. 检查网络连接
2. 重启客户端
3. 检查文件权限
