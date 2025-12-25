#!/usr/bin/env bun

/**
 * CRDT 同步服务器
 * 提供 WebSocket 服务，用于同步 CRDT 文档
 */

import { WebSocketServer } from 'ws'
import * as http from 'http'

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 1234

/**
 * 创建 HTTP 服务器
 */
const server = http.createServer()

/**
 * 创建 WebSocket 服务器
 */
const wss = new WebSocketServer({ server })

/**
 * 存储每个文件的 CRDT 文档状态
 * key: 文件路径, value: WebSocket 连接数组
 */
const fileConnections = new Map<string, Set<any>>()

/**
 * 处理 WebSocket 连接
 */
wss.on('connection', (ws, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    const filePath = url.searchParams.get('file') || 'default'
    
    console.log(`[Server] 新连接: ${filePath}`)
    
    // 初始化文件连接集合
    if (!fileConnections.has(filePath)) {
        fileConnections.set(filePath, new Set())
    }
    fileConnections.get(filePath)!.add(ws)
    
    /**
     * 广播消息给同一文件的其他连接
     */
    ws.on('message', (data: Buffer) => {
        const connections = fileConnections.get(filePath)!
        connections.forEach((conn) => {
            if (conn !== ws && conn.readyState === 1) { // WebSocket.OPEN
                conn.send(data)
            }
        })
    })
    
    /**
     * 清理连接
     */
    ws.on('close', () => {
        console.log(`[Server] 连接关闭: ${filePath}`)
        const connections = fileConnections.get(filePath)!
        connections.delete(ws)
        if (connections.size === 0) {
            fileConnections.delete(filePath)
        }
    })
    
    ws.on('error', (error) => {
        console.error(`[Server] WebSocket 错误:`, error)
    })
})

/**
 * 启动服务器
 */
server.listen(PORT, () => {
    console.log(`[Server] CRDT 同步服务器启动在端口 ${PORT}`)
    console.log(`[Server] WebSocket 地址: ws://localhost:${PORT}`)
})
