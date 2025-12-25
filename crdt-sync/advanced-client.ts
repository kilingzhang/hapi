#!/usr/bin/env bun

/**
 * 高级 CRDT 文件同步客户端
 * 使用智能 diff 算法，只同步变更部分
 */

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as fs from 'fs/promises'
import * as path from 'path'
import chokidar from 'chokidar'

/**
 * 简单的 diff 算法实现
 * 计算两个字符串的差异并转换为操作序列
 */
class SimpleDiff {
    /**
     * 计算两个字符串的差异
     * 返回操作序列：{ type: 'insert' | 'delete', pos: number, text: string }[]
     */
    static diff(oldText: string, newText: string): Array<{ type: 'insert' | 'delete', pos: number, text: string }> {
        const operations: Array<{ type: 'insert' | 'delete', pos: number, text: string }> = []
        
        // 简单的字符级 diff（实际可以使用更高级的算法如 Myers diff）
        let i = 0
        let j = 0
        
        while (i < oldText.length || j < newText.length) {
            if (i < oldText.length && j < newText.length && oldText[i] === newText[j]) {
                i++
                j++
            } else {
                // 找到不同的部分
                const deleteStart = i
                const insertStart = j
                
                // 计算需要删除的长度
                let deleteLen = 0
                while (i < oldText.length && (j >= newText.length || oldText[i] !== newText[j])) {
                    i++
                    deleteLen++
                }
                
                // 计算需要插入的文本
                let insertText = ''
                while (j < newText.length && (i >= oldText.length || oldText[i] !== newText[j])) {
                    insertText += newText[j]
                    j++
                }
                
                if (deleteLen > 0) {
                    operations.push({
                        type: 'delete',
                        pos: deleteStart,
                        text: oldText.substring(deleteStart, deleteStart + deleteLen)
                    })
                }
                
                if (insertText.length > 0) {
                    operations.push({
                        type: 'insert',
                        pos: insertStart,
                        text: insertText
                    })
                }
            }
        }
        
        return operations
    }
}

/**
 * 高级文件同步管理器
 */
class AdvancedCRDTFileSync {
    private ydocs: Map<string, Y.Doc> = new Map()
    private providers: Map<string, WebsocketProvider> = new Map()
    private ytexts: Map<string, Y.Text> = new Map()
    private isApplyingRemoteChange = false
    private fileVersions: Map<string, string> = new Map() // 存储文件版本，用于 diff
    
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
            relativePath,
            ydoc
        )
        
        // 等待连接建立
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('连接超时'))
            }, 10000)
            
            provider.on('status', (event: { status: string }) => {
                if (event.status === 'connected') {
                    clearTimeout(timeout)
                    console.log(`[Client] 已连接: ${relativePath}`)
                    resolve()
                } else if (event.status === 'disconnected') {
                    console.warn(`[Client] 连接断开: ${relativePath}`)
                }
            })
        })
        
        // 加载文件内容到 CRDT
        try {
            const content = await fs.readFile(filePath, 'utf-8')
            if (content) {
                ytext.delete(0, ytext.length)
                ytext.insert(0, content)
                this.fileVersions.set(filePath, content)
            }
        } catch (error) {
            console.log(`[Client] 文件不存在，创建新文档: ${relativePath}`)
            this.fileVersions.set(filePath, '')
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
        
        provider.on('connection-error', (error: Error) => {
            console.error(`[Client] 连接错误: ${relativePath}`, error)
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
            const oldContent = this.fileVersions.get(filePath) || ''
            
            if (content !== oldContent) {
                await fs.writeFile(filePath, content, 'utf-8')
                this.fileVersions.set(filePath, content)
                console.log(`[Client] 远端变更已应用: ${path.relative(SYNC_DIR, filePath)}`)
            }
        } catch (error) {
            console.error(`[Client] 写入文件失败:`, error)
        } finally {
            setTimeout(() => {
                this.isApplyingRemoteChange = false
            }, 100)
        }
    }
    
    /**
     * 文件系统变更时更新 CRDT（使用智能 diff）
     */
    async onFileSystemChange(filePath: string) {
        if (this.isApplyingRemoteChange) {
            return
        }
        
        const ytext = this.ytexts.get(filePath)
        if (!ytext) {
            await this.initFile(filePath)
            return
        }
        
        try {
            const newContent = await fs.readFile(filePath, 'utf-8')
            const oldContent = this.fileVersions.get(filePath) || ytext.toString()
            
            if (newContent !== oldContent) {
                // 使用 diff 算法计算变更
                const operations = SimpleDiff.diff(oldContent, newContent)
                
                // 应用操作到 CRDT（反向应用，因为需要从后往前删除）
                const sortedOps = operations.sort((a, b) => b.pos - a.pos)
                
                for (const op of sortedOps) {
                    if (op.type === 'delete') {
                        ytext.delete(op.pos, op.text.length)
                    } else if (op.type === 'insert') {
                        ytext.insert(op.pos, op.text)
                    }
                }
                
                this.fileVersions.set(filePath, newContent)
                console.log(`[Client] 本地变更已同步 (${operations.length} 个操作): ${path.relative(SYNC_DIR, filePath)}`)
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                ytext.delete(0, ytext.length)
                this.fileVersions.delete(filePath)
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
        console.log(`[Client] 正在清理资源...`)
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
    const SYNC_DIR = process.argv.find(arg => arg.startsWith('--dir='))?.split('=')[1] || process.cwd()
    const WS_SERVER = process.argv.find(arg => arg.startsWith('--server='))?.split('=')[1] || 'ws://localhost:1234'
    
    console.log(`[Client] 高级 CRDT 文件同步客户端`)
    console.log(`[Client] 同步目录: ${SYNC_DIR}`)
    console.log(`[Client] WebSocket 服务器: ${WS_SERVER}`)
    
    const sync = new AdvancedCRDTFileSync()
    
    async function initExistingFiles(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            
            if (entry.name.startsWith('.')) {
                continue
            }
            
            if (entry.isDirectory()) {
                await initExistingFiles(fullPath)
            } else if (entry.isFile()) {
                if (isTextFile(entry.name)) {
                    await sync.initFile(fullPath)
                }
            }
        }
    }
    
    function isTextFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase()
        const textExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.css', '.html', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h']
        return textExtensions.includes(ext) || !ext
    }
    
    console.log(`[Client] 初始化现有文件...`)
    await initExistingFiles(SYNC_DIR)
    
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
        console.log(`[Client] 文件已删除: ${path.relative(SYNC_DIR, filePath)}`)
    })
    
    console.log(`[Client] 文件监听已启动`)
    
    process.on('SIGINT', async () => {
        console.log(`[Client] 正在关闭...`)
        await watcher.close()
        await sync.cleanup()
        process.exit(0)
    })
}

main().catch(console.error)
