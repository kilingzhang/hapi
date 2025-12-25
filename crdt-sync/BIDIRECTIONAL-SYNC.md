# 双向同步完整指南

## 架构说明

CRDT 同步方案**天然支持双向同步**，两端都需要运行客户端。

```
┌─────────────────────────────────────────────────────────┐
│                  WebSocket 服务器                        │
│                  (server.ts)                            │
│                                                         │
│  管理连接，转发 CRDT 操作                                │
└───────────────┬───────────────────┬─────────────────────┘
                │                   │
                │                   │
    ┌───────────▼────────┐  ┌──────▼──────────┐
    │   本地机器          │  │   远端机器       │
    │                    │  │                 │
    │  client.ts         │  │  client.ts      │
    │  ┌──────────────┐  │  │  ┌────────────┐ │
    │  │ 文件系统监听  │  │  │  │文件系统监听│ │
    │  │ CRDT 文档    │  │  │  │CRDT 文档  │ │
    │  └──────────────┘  │  │  └────────────┘ │
    │                    │  │                 │
    │  可以编辑文件 ✅    │  │  可以编辑文件 ✅ │
    └────────────────────┘  └─────────────────┘
```

## 完整设置步骤

### 步骤 1: 启动同步服务器

**选择一台机器运行服务器**（可以是本地、远端或独立服务器）：

```bash
# 终端 1
cd crdt-sync
bun run server.ts
```

输出：
```
[Server] CRDT 同步服务器启动在端口 1234
[Server] WebSocket 地址: ws://localhost:1234
```

### 步骤 2: 在本地启动客户端

```bash
# 终端 2（本地机器）
cd crdt-sync
bun run client.ts --dir=/path/to/your/project --server=ws://server-ip:1234
```

### 步骤 3: 在远端启动客户端

**方式 A: SSH 登录远端**

```bash
# SSH 到远端机器
ssh user@remote-server

# 在远端运行
cd crdt-sync
bun run client.ts --dir=/path/to/same/project --server=ws://server-ip:1234
```

**方式 B: 使用管理脚本**

```bash
# 在远端机器上
cd crdt-sync
bun run remote-manager.ts start --dir=/path/to/project --server=ws://server-ip:1234
```

**方式 C: 作为服务运行（Linux）**

```bash
# 使用提供的设置脚本
./remote-setup.sh /path/to/project ws://server-ip:1234

# 启动服务
sudo systemctl start crdt-sync-project-name
```

## 双向同步工作原理

### 场景 1: 本地编辑 → 远端同步

```
1. 本地用户编辑文件
   ↓
2. 文件系统监听检测到变化
   ↓
3. 转换为 CRDT 操作
   ↓
4. WebSocket 发送到服务器
   ↓
5. 服务器转发到远端客户端
   ↓
6. 远端 CRDT 应用操作
   ↓
7. 远端文件自动更新 ✅
```

### 场景 2: 远端编辑 → 本地同步

```
1. 远端用户（或 agent）编辑文件
   ↓
2. 远端文件系统监听检测到变化
   ↓
3. 转换为 CRDT 操作
   ↓
4. WebSocket 发送到服务器
   ↓
5. 服务器转发到本地客户端
   ↓
6. 本地 CRDT 应用操作
   ↓
7. 本地文件自动更新 ✅
```

### 场景 3: 两端同时编辑

```
初始: "Hello World"

本地: insert(6, "Beautiful ")
  → "Hello Beautiful World"

远端: insert(11, "!")
  → "Hello World!"

CRDT 自动合并:
  → "Hello Beautiful World!" ✅
```

## 远端管理

### 使用管理工具

```bash
# 启动
bun run remote-manager.ts start --dir=/path/to/project --server=ws://server:1234

# 查看状态
bun run remote-manager.ts status --dir=/path/to/project

# 查看日志
bun run remote-manager.ts logs --dir=/path/to/project

# 停止
bun run remote-manager.ts stop --dir=/path/to/project

# 重启
bun run remote-manager.ts restart --dir=/path/to/project
```

### 作为系统服务（Linux）

```bash
# 设置服务
./remote-setup.sh /path/to/project ws://server:1234

# 启动
sudo systemctl start crdt-sync-project-name

# 开机自启
sudo systemctl enable crdt-sync-project-name

# 查看状态
sudo systemctl status crdt-sync-project-name

# 查看日志
sudo journalctl -u crdt-sync-project-name -f
```

## 远端 Agent 集成

如果远端是 code agent，可以在 agent 代码中集成：

```typescript
// 在远端 agent 中
import { CRDTFileSync } from './crdt-sync/client'

class Agent {
    private sync: CRDTFileSync
    
    async init() {
        this.sync = new CRDTFileSync({
            dir: '/path/to/project',
            server: 'ws://your-server:1234'
        })
        
        // 初始化所有文件
        await this.sync.initAllFiles()
    }
    
    async editFile(filePath: string, content: string) {
        // Agent 编辑文件
        await fs.writeFile(filePath, content)
        
        // CRDT 会自动检测并同步（通过文件系统监听）
        // 或者手动触发同步：
        await this.sync.onFileSystemChange(filePath)
    }
}
```

## 验证双向同步

### 测试步骤

1. **启动服务器和两端客户端**

2. **本地编辑测试**
   ```bash
   # 在本地编辑文件
   echo "// Local edit" >> test.ts
   ```
   观察远端文件是否自动更新

3. **远端编辑测试**
   ```bash
   # 在远端编辑文件
   echo "// Remote edit" >> test.ts
   ```
   观察本地文件是否自动更新

4. **同时编辑测试**
   - 本地：在第 10 行添加内容
   - 远端：在第 20 行添加内容
   - 观察两端是否都包含两处修改

## 常见问题

### Q: 远端如何知道服务器地址？

A: 启动客户端时通过 `--server` 参数指定：
```bash
bun run client.ts --dir=/path/to/project --server=ws://your-server-ip:1234
```

### Q: 如果服务器在本地，远端如何连接？

A: 确保服务器地址是远端可以访问的 IP：
```bash
# 本地启动服务器（监听所有接口）
bun run server.ts

# 远端连接（使用本地机器的公网 IP 或内网 IP）
bun run client.ts --dir=/path/to/project --server=ws://192.168.1.100:1234
```

### Q: 可以多个远端同时连接吗？

A: 可以！服务器支持多个客户端连接同一个文件。

### Q: 如果网络断开怎么办？

A: CRDT 会缓存操作，网络恢复后自动同步。

## 总结

✅ **双向同步**：两端都可以编辑  
✅ **实时同步**：编辑立即同步  
✅ **无冲突**：CRDT 自动合并  
✅ **透明**：不需要改变编辑习惯  
✅ **灵活**：支持任何编辑器

只需要：
1. 启动服务器
2. 两端都运行客户端
3. 正常编辑文件即可！
