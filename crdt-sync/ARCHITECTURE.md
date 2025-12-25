# CRDT 文件同步架构详解

## 核心概念

### 什么是 CRDT？

CRDT (Conflict-free Replicated Data Type) 是一种数据结构，设计用于分布式系统中的数据同步。

**关键特性：**
- ✅ **无冲突合并**：多个副本可以独立修改，然后自动合并
- ✅ **操作可交换**：操作的顺序不影响最终结果
- ✅ **最终一致性**：所有副本最终会达到一致状态

### CRDT 如何工作？

#### 1. 操作标识

每个操作都有唯一标识：
```
操作 = {
    id: "client-id:timestamp:sequence",
    type: "insert" | "delete",
    position: number,
    content: string
}
```

#### 2. 向量时钟 (Vector Clock)

跟踪每个客户端的操作顺序：
```
VectorClock = {
    "client-A": 5,  // client-A 执行了 5 个操作
    "client-B": 3,  // client-B 执行了 3 个操作
}
```

#### 3. 操作合并规则

**插入操作：**
- 如果位置不同：两个插入都保留
- 如果位置相同：根据客户端 ID 和时间戳排序

**删除操作：**
- 删除操作会标记字符为"已删除"
- 已删除的字符不会被插入操作影响

## 架构设计

```
┌─────────────────┐         ┌─────────────────┐
│   本地文件系统   │         │   远端文件系统   │
│                 │         │                 │
│  test.ts        │         │  test.ts        │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │ 文件监听                   │ 文件监听
         │                           │
┌────────▼────────┐         ┌────────▼────────┐
│  本地 CRDT 文档  │         │  远端 CRDT 文档  │
│                 │         │                 │
│  Y.Text         │◄───────►│  Y.Text         │
│  (操作序列)      │ WebSocket│  (操作序列)      │
└─────────────────┘         └─────────────────┘
         │                           │
         │                           │
    ┌────▼───────────────────────────▼────┐
    │      WebSocket 同步服务器            │
    │      (server.ts)                    │
    │                                     │
    │  - 转发操作                         │
    │  - 管理连接                         │
    └─────────────────────────────────────┘
```

## 数据流

### 场景 1：本地编辑 → 远端同步

```
1. 用户在本地编辑文件
   ↓
2. 文件系统监听检测到变化
   ↓
3. 计算 diff（新旧内容差异）
   ↓
4. 将 diff 转换为 CRDT 操作
   ↓
5. 操作应用到本地 CRDT 文档
   ↓
6. WebSocket 发送操作到服务器
   ↓
7. 服务器转发到远端客户端
   ↓
8. 远端应用操作到 CRDT 文档
   ↓
9. CRDT 文档内容写回远端文件系统
```

### 场景 2：两端同时编辑

```
初始状态: "Hello World"

本地操作（时间 T1）:
  insert(6, "Beautiful ")
  结果: "Hello Beautiful World"

远端操作（时间 T2）:
  insert(11, "!")
  结果: "Hello World!"

合并过程:
  1. 本地操作先到达: insert(6, "Beautiful ")
     → "Hello Beautiful World"
  
  2. 远端操作到达，位置需要调整:
     原位置: 11
     调整后: 11 + "Beautiful ".length = 21
     insert(21, "!")
     → "Hello Beautiful World!"
  
  3. 最终结果: "Hello Beautiful World!"
```

## 关键技术点

### 1. 文件系统 ↔ CRDT 转换

**文件系统 → CRDT：**
- 监听文件变化
- 计算 diff
- 转换为 CRDT 操作

**CRDT → 文件系统：**
- CRDT 文档变化时
- 获取完整内容
- 写回文件系统

### 2. 冲突避免

**为什么 CRDT 不会冲突？**

1. **操作可交换性**：插入操作的位置是相对于文档当前状态的
2. **唯一标识**：每个操作都有唯一 ID，不会重复应用
3. **向量时钟**：确定操作的全局顺序

### 3. 性能优化

**操作级同步：**
- 只同步变更的操作，不是整个文件
- 减少网络传输

**批量操作：**
- 多个操作可以批量发送
- 减少网络往返

**增量更新：**
- CRDT 支持增量更新
- 只传输变更部分

## 实现细节

### Yjs 库的使用

Yjs 是一个成熟的 CRDT 实现库：

```typescript
// 创建文档
const ydoc = new Y.Doc()

// 创建文本类型
const ytext = ydoc.getText('content')

// 插入文本
ytext.insert(0, 'Hello')

// 删除文本
ytext.delete(0, 5)

// 监听变化
ytext.observe((event) => {
    // 处理变化
})
```

### WebSocket Provider

Yjs 的 WebSocket Provider 负责：
- 建立 WebSocket 连接
- 同步 CRDT 文档状态
- 传输操作

```typescript
const provider = new WebsocketProvider(
    'ws://server:1234',  // 服务器地址
    'room-name',         // 房间名（文件路径）
    ydoc                 // CRDT 文档
)
```

## 优势与限制

### 优势

1. **真正的无冲突**：不需要手动解决冲突
2. **实时同步**：操作立即同步
3. **操作级同步**：只同步变更，效率高
4. **最终一致性**：保证所有副本最终一致

### 限制

1. **文本文件为主**：二进制文件需要特殊处理
2. **内存占用**：CRDT 文档需要维护操作历史
3. **网络要求**：需要稳定的网络连接
4. **大文件性能**：非常大的文件可能需要优化

## 扩展方案

### 1. 使用 WebRTC（P2P）

无需中央服务器，直接点对点连接：

```typescript
import { WebrtcProvider } from 'y-webrtc'

const provider = new WebrtcProvider(roomName, ydoc)
```

### 2. 使用 HTTP 同步

适合低频率同步场景：

```typescript
import { HttpProvider } from 'y-http'

const provider = new HttpProvider('http://server/api', ydoc)
```

### 3. 支持二进制文件

使用 Yjs 的 Array 类型存储二进制数据：

```typescript
const yarray = ydoc.getArray('binary')
// 将文件转换为 Uint8Array
yarray.insert(0, [binaryData])
```

## 总结

CRDT-based 文件同步提供了：
- ✅ 优雅的冲突处理（无冲突）
- ✅ 实时双向同步
- ✅ 操作级同步（高效）
- ✅ 最终一致性保证

这是目前最优雅的文件同步方案之一，被 VS Code Live Share、Google Docs 等产品使用。
