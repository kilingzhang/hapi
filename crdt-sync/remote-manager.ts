#!/usr/bin/env bun

/**
 * 远端 CRDT 同步管理器
 * 提供启动、停止、状态查看等功能
 */

import { spawn, execSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'

interface SyncConfig {
    projectDir: string
    server: string
    pidFile?: string
    logFile?: string
}

class RemoteSyncManager {
    private config: SyncConfig
    private pidFile: string
    private logFile: string
    
    constructor(config: SyncConfig) {
        this.config = config
        this.pidFile = config.pidFile || path.join(config.projectDir, '.crdt-sync.pid')
        this.logFile = config.logFile || path.join(config.projectDir, '.crdt-sync.log')
    }
    
    /**
     * 启动同步客户端
     */
    async start(): Promise<void> {
        if (await this.isRunning()) {
            console.log('同步客户端已在运行')
            return
        }
        
        console.log(`启动 CRDT 同步客户端...`)
        console.log(`项目目录: ${this.config.projectDir}`)
        console.log(`服务器: ${this.config.server}`)
        
        const scriptPath = path.join(__dirname, 'client.ts')
        const child = spawn('bun', [
            'run',
            scriptPath,
            `--dir=${this.config.projectDir}`,
            `--server=${this.config.server}`
        ], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        
        // 保存 PID
        await fs.writeFile(this.pidFile, child.pid!.toString(), 'utf-8')
        
        // 重定向输出到日志文件
        const logStream = await fs.open(this.logFile, 'a')
        child.stdout?.pipe(logStream.createWriteStream())
        child.stderr?.pipe(logStream.createWriteStream())
        
        child.unref()
        
        console.log(`同步客户端已启动 (PID: ${child.pid})`)
        console.log(`日志文件: ${this.logFile}`)
    }
    
    /**
     * 停止同步客户端
     */
    async stop(): Promise<void> {
        if (!(await this.isRunning())) {
            console.log('同步客户端未运行')
            return
        }
        
        const pid = parseInt(await fs.readFile(this.pidFile, 'utf-8'))
        console.log(`停止同步客户端 (PID: ${pid})...`)
        
        try {
            process.kill(pid, 'SIGTERM')
            await fs.unlink(this.pidFile)
            console.log('同步客户端已停止')
        } catch (error) {
            console.error('停止失败:', error)
        }
    }
    
    /**
     * 重启同步客户端
     */
    async restart(): Promise<void> {
        await this.stop()
        await new Promise(resolve => setTimeout(resolve, 1000))
        await this.start()
    }
    
    /**
     * 查看状态
     */
    async status(): Promise<void> {
        const isRunning = await this.isRunning()
        
        console.log('=== CRDT 同步客户端状态 ===')
        console.log(`项目目录: ${this.config.projectDir}`)
        console.log(`服务器: ${this.config.server}`)
        console.log(`状态: ${isRunning ? '运行中' : '未运行'}`)
        
        if (isRunning) {
            const pid = parseInt(await fs.readFile(this.pidFile, 'utf-8'))
            console.log(`PID: ${pid}`)
            
            // 显示日志最后几行
            try {
                const logContent = await fs.readFile(this.logFile, 'utf-8')
                const lines = logContent.split('\n').filter(l => l.trim())
                const lastLines = lines.slice(-10)
                
                console.log('\n最近日志:')
                lastLines.forEach(line => console.log(`  ${line}`))
            } catch (error) {
                // 日志文件不存在或无法读取
            }
        }
        
        console.log(`日志文件: ${this.logFile}`)
    }
    
    /**
     * 查看日志
     */
    async logs(lines: number = 50): Promise<void> {
        try {
            const logContent = await fs.readFile(this.logFile, 'utf-8')
            const logLines = logContent.split('\n').filter(l => l.trim())
            const lastLines = logLines.slice(-lines)
            
            console.log(`=== 最后 ${lastLines.length} 行日志 ===`)
            lastLines.forEach(line => console.log(line))
        } catch (error) {
            console.log('日志文件不存在或无法读取')
        }
    }
    
    /**
     * 检查是否正在运行
     */
    private async isRunning(): Promise<boolean> {
        try {
            const pid = parseInt(await fs.readFile(this.pidFile, 'utf-8'))
            
            // 检查进程是否存在
            try {
                process.kill(pid, 0) // 发送信号 0 检查进程是否存在
                return true
            } catch {
                // 进程不存在，删除 PID 文件
                await fs.unlink(this.pidFile).catch(() => {})
                return false
            }
        } catch {
            return false
        }
    }
}

/**
 * CLI 入口
 */
async function main() {
    const args = process.argv.slice(2)
    const command = args[0]
    
    if (!command || !['start', 'stop', 'restart', 'status', 'logs'].includes(command)) {
        console.log('用法: bun run remote-manager.ts <command> [options]')
        console.log('')
        console.log('命令:')
        console.log('  start   启动同步客户端')
        console.log('  stop    停止同步客户端')
        console.log('  restart 重启同步客户端')
        console.log('  status  查看状态')
        console.log('  logs    查看日志')
        console.log('')
        console.log('选项:')
        console.log('  --dir=<path>     项目目录 (必需)')
        console.log('  --server=<url>   WebSocket 服务器地址 (默认: ws://localhost:1234)')
        console.log('')
        console.log('示例:')
        console.log('  bun run remote-manager.ts start --dir=/path/to/project --server=ws://server:1234')
        console.log('  bun run remote-manager.ts status --dir=/path/to/project')
        process.exit(1)
    }
    
    const dirArg = args.find(arg => arg.startsWith('--dir='))?.split('=')[1]
    const serverArg = args.find(arg => arg.startsWith('--server='))?.split('=')[1] || 'ws://localhost:1234'
    
    if (!dirArg) {
        console.error('错误: 需要指定 --dir 参数')
        process.exit(1)
    }
    
    const manager = new RemoteSyncManager({
        projectDir: path.resolve(dirArg),
        server: serverArg
    })
    
    switch (command) {
        case 'start':
            await manager.start()
            break
        case 'stop':
            await manager.stop()
            break
        case 'restart':
            await manager.restart()
            break
        case 'status':
            await manager.status()
            break
        case 'logs':
            const linesArg = args.find(arg => arg.startsWith('--lines='))?.split('=')[1]
            await manager.logs(linesArg ? parseInt(linesArg) : 50)
            break
    }
}

main().catch(console.error)
