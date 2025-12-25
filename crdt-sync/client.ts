#!/usr/bin/env bun

/**
 * CRDT 文件同步客户端
 * 监听文件系统变化，通过 CRDT 同步到远端
 */

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as fs from 'fs/promises'
import * as path from 'path'
import chokidar from 'chokidar'

/**
 * 配置参数
 */
const args = process.argv.slice(2)
const dirArg = args.find(arg => arg.startsWith('--dir='))?.split('=')[1] || process.cwd()
const serverArg = args.find(arg => arg.startsWith('--server='))?.split('=')[1] || 'ws://localhost:1234'

const SYNC_DIR = path.resolve(dirArg)
const WS_SERVER = serverArg

console.log(`[Client] 同步目录: ${SYNC_DIR}`)
console.log(`[Client] WebSocket 服务器: ${WS_SERVER}`)

/**
 * 文件同步管理器
 */
class CRDTFileSync {
    private ydocs: Map<string, Y.Doc> = new Map()
    private providers: Map<string, WebsocketProvider> = new Map()
    private ytexts: Map<string, Y.Text> = new Map()
    private isApplyingRemoteChange = false
    
    /**
     * 初始化文件的 CRDT 同步
     */
    async initFile(filePath: string) {
        const relativePath = path.relative(SYNC_DIR, filePath)
        
        // 创建 CRDT 文档
        const ydoc = new Y.Doc()
        const ytext = ydoc.getText('content')
        
        // 创建 WebSocket Provider
        const provider = new WebsocketProvider(
            WS_SERVER,
            relativePath, // 使用相对路径作为房间名
            ydoc
        )
        
        // 等待连接建立
        await new Promise<void>((resolve) => {
            provider.on('status', (event: { status: string }) => {
                if (event.status === 'connected') {
                    console.log(`[Client] 已连接: ${relativePath}`)
                    resolve()
                }
            })
        })
        
        // 加载文件内容到 CRDT
        try {
            const content = await fs.readFile(filePath, 'utf-8')
            if (content) {
                ytext.delete(0, ytext.length)
                ytext.insert(0, content)
            }
        } catch (error) {
            // 文件不存在，创建空文档
            console.log(`[Client] 文件不存在，创建新文档: ${relativePath}`)
        }
        
        // 监听 CRDT 变更（远端修改）
        ytext.observe((event: Y.YTextEvent) => {
            if (!this.isApplyingRemoteChange) {
                this.onCRDTChange(filePath, ytext)
            }
        })
        
        // 监听 Provider 同步事件
        provider.on('sync', (isSynced: boolean) => {
            if (isSynced) {
                console.log(`[Client] 同步完成: ${relativePath}`)
            }
        })
        
        this.ydocs.set(filePath, ydoc)
        this.providers.set(filePath, provider)
        this.ytexts.set(filePath, ytext)
    }
    
    /**
     * CRDT 变更时写回文件系统
     */
    private async onCRDTChange(filePath: string, ytext: Y.Text) {
        this.isApplyingRemoteChange = true
        
        try {
            const content = ytext.toString()
            await fs.writeFile(filePath, content, 'utf-8')
            console.log(`[Client] 远端变更已应用: ${path.relative(SYNC_DIR, filePath)}`)
        } catch (error) {
            console.error(`[Client] 写入文件失败:`, error)
        } finally {
            // 延迟重置标志，避免文件系统监听触发
            setTimeout(() => {
                this.isApplyingRemoteChange = false
            }, 100)
        }
    }
    
    /**
     * 文件系统变更时更新 CRDT
     */
    async onFileSystemChange(filePath: string) {
        if (this.isApplyingRemoteChange) {
            return // 忽略由远端变更引起的文件系统变化
        }
        
        const ytext = this.ytexts.get(filePath)
        if (!ytext) {
            // 新文件，初始化
            await this.initFile(filePath)
            return
        }
        
        try {
            const newContent = await fs.readFile(filePath, 'utf-8')
            const currentContent = ytext.toString()
            
            if (newContent !== currentContent) {
                // 计算差异并应用
                // 简单策略：完全替换（实际可以使用更智能的 diff）
                ytext.delete(0, ytext.length)
                ytext.insert(0, newContent)
                console.log(`[Client] 本地变更已同步: ${path.relative(SYNC_DIR, filePath)}`)
            }
        } catch (error) {
            // 文件可能被删除
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                ytext.delete(0, ytext.length)
                console.log(`[Client] 文件已删除: ${path.relative(SYNC_DIR, filePath)}`)
            } else {
                console.error(`[Client] 读取文件失败:`, error)
            }
        }
    }
    
    /**
     * 清理资源
     */
    async cleanup() {
        for (const [filePath, provider] of this.providers) {
            provider.destroy()
        }
        for (const [filePath, ydoc] of this.ydocs) {
            ydoc.destroy()
        }
    }
}

/**
 * 主函数
 */
async function main() {
    const sync = new CRDTFileSync()
    
    // 初始化已存在的文件
    async function initExistingFiles(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            
            // 忽略隐藏文件和目录
            if (entry.name.startsWith('.')) {
                continue
            }
            
            if (entry.isDirectory()) {
                await initExistingFiles(fullPath)
            } else if (entry.isFile()) {
                // 只同步文本文件（可以根据需要扩展）
                if (isTextFile(entry.name)) {
                    await sync.initFile(fullPath)
                }
            }
        }
    }
    
    /**
     * 判断是否为文本文件
     */
    function isTextFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase()
        const textExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.css', '.html', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h']
        return textExtensions.includes(ext) || !ext
    }
    
    // 初始化现有文件
    console.log(`[Client] 初始化现有文件...`)
    await initExistingFiles(SYNC_DIR)
    
    // 监听文件系统变化
    const watcher = chokidar.watch(SYNC_DIR, {
        ignored: [
            /node_modules/,
            /\.git/,
            /\.crdt-sync/,
            /\.DS_Store/
        ],
        ignoreInitial: true,
        persistent: true
    })
    
    watcher.on('add', async (filePath) => {
        if (isTextFile(filePath)) {
            await sync.initFile(filePath)
        }
    })
    
    watcher.on('change', async (filePath) => {
        if (isTextFile(filePath)) {
            await sync.onFileSystemChange(filePath)
        }
    })
    
    watcher.on('unlink', async (filePath) => {
        // 文件删除处理
        console.log(`[Client] 文件已删除: ${path.relative(SYNC_DIR, filePath)}`)
    })
    
    console.log(`[Client] 文件监听已启动`)
    
    // 优雅退出
    process.on('SIGINT', async () => {
        console.log(`[Client] 正在关闭...`)
        await watcher.close()
        await sync.cleanup()
        process.exit(0)
    })
}

main().catch(console.error)
