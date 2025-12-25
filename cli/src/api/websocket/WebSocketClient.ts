/**
 * WebSocket client for HAPI protocol
 * 
 * Replaces socket.io-client with native WebSocket implementation
 * Maintains full feature parity with Socket.IO version
 */

import { EventEmitter } from 'node:events'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'

export interface ConnectionMessage {
    id: string
    type: string
    payload: unknown
    timestamp: number
}

export interface WebSocketClientOptions {
    token: string
    clientType: 'session-scoped' | 'machine-scoped'
    sessionId?: string | null
    machineId?: string | null
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onError?: (error: Error) => void
    onMessage?: (message: ConnectionMessage) => void
}

export class WebSocketClient extends EventEmitter {
    private ws: WebSocket | null = null
    private socketId: string | null = null
    private authenticated = false
    private reconnectAttempts = 0
    private reconnectTimer: NodeJS.Timeout | null = null
    private readonly options: WebSocketClientOptions
    private readonly reconnectDelay = 1000
    private readonly maxReconnectDelay = 5000
    private pendingRequests: Map<string, {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timeout: NodeJS.Timeout
    }> = new Map()
    private heartbeatInterval: NodeJS.Timeout | null = null

    constructor(options: WebSocketClientOptions) {
        super()
        this.options = options
    }

    connect(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return
        }

        const wsUrl = new URL('/ws/cli', configuration.serverUrl)
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
        wsUrl.searchParams.set('token', this.options.token)

        try {
            this.ws = new WebSocket(wsUrl.toString())
            this.setupWebSocket()
        } catch (error) {
            logger.debug('[WebSocketClient] Connection error:', error)
            this.scheduleReconnect()
        }
    }

    private setupWebSocket(): void {
        if (!this.ws) return

        this.ws.addEventListener('open', () => {
            logger.debug('[WebSocketClient] WebSocket opened')
            this.reconnectAttempts = 0
            this.authenticate()
        })

        this.ws.addEventListener('message', (event) => {
            try {
                const message: ConnectionMessage = JSON.parse(event.data as string)
                this.handleMessage(message)
            } catch (error) {
                logger.debug('[WebSocketClient] Error parsing message:', error)
            }
        })

        this.ws.addEventListener('close', (event) => {
            logger.debug('[WebSocketClient] WebSocket closed:', event.code, event.reason)
            this.authenticated = false
            this.socketId = null
            this.stopHeartbeat()
            this.options.onDisconnect?.(event.reason || 'Connection closed')
            this.scheduleReconnect()
        })

        this.ws.addEventListener('error', (error) => {
            logger.debug('[WebSocketClient] WebSocket error:', error)
            this.options.onError?.(error as Error)
        })
    }

    private authenticate(): void {
        if (!this.ws) return

        this.send({
            id: this.generateId(),
            type: 'auth',
            payload: {
                token: this.options.token,
                clientType: this.options.clientType,
                sessionId: this.options.sessionId ?? null,
                machineId: this.options.machineId ?? null
            },
            timestamp: Date.now()
        })
    }

    private handleMessage(message: ConnectionMessage): void {
        // Handle auth response
        if (message.type === 'auth:ack') {
            const payload = message.payload as {
                success: boolean
                socketId: string | null
                error: string | null
            }

            if (payload.success && payload.socketId) {
                this.authenticated = true
                this.socketId = payload.socketId
                this.options.onConnect?.()
                this.startHeartbeat()
                this.emit('connect')
            } else {
                logger.debug('[WebSocketClient] Authentication failed:', payload.error)
                this.ws?.close(1008, payload.error || 'Authentication failed')
            }
            return
        }

        // Handle RPC request
        if (message.type === 'rpc:request') {
            this.emit('rpc-request', message)
            return
        }

        // Handle update broadcasts
        if (message.type === 'update') {
            this.emit('update', message)
            return
        }

        // Handle ACK responses
        if (message.type.endsWith(':ack')) {
            const pending = this.pendingRequests.get(message.id)
            if (pending) {
                clearTimeout(pending.timeout)
                this.pendingRequests.delete(message.id)
                pending.resolve(message.payload)
            }
            return
        }

        // Handle pong
        if (message.type === 'pong') {
            const pending = this.pendingRequests.get(message.id)
            if (pending) {
                clearTimeout(pending.timeout)
                this.pendingRequests.delete(message.id)
                pending.resolve({})
            }
            return
        }

        // Forward other messages
        this.options.onMessage?.(message)
    }

    send(message: ConnectionMessage): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger.debug('[WebSocketClient] Cannot send message, WebSocket not open')
            return
        }

        this.ws.send(JSON.stringify(message))
    }

    sendWithAck(message: ConnectionMessage, timeoutMs = 30_000): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(message.id)
                reject(new Error('Request timeout'))
            }, timeoutMs)

            this.pendingRequests.set(message.id, {
                resolve,
                reject,
                timeout
            })

            this.send(message)
        })
    }

    registerRpc(method: string): void {
        this.send({
            id: this.generateId(),
            type: 'rpc:register',
            payload: { method },
            timestamp: Date.now()
        })
    }

    unregisterRpc(method: string): void {
        this.send({
            id: this.generateId(),
            type: 'rpc:unregister',
            payload: { method },
            timestamp: Date.now()
        })
    }

    sendMessage(sessionId: string, content: unknown, localId?: string | null): void {
        this.send({
            id: this.generateId(),
            type: 'message',
            payload: {
                sessionId,
                content,
                localId: localId ?? null
            },
            timestamp: Date.now()
        })
    }

    updateMetadata(sessionId: string, expectedVersion: number, metadata: unknown): Promise<unknown> {
        return this.sendWithAck({
            id: this.generateId(),
            type: 'update-metadata',
            payload: {
                sessionId,
                expectedVersion,
                metadata
            },
            timestamp: Date.now()
        })
    }

    updateState(sessionId: string, expectedVersion: number, agentState: unknown | null): Promise<unknown> {
        return this.sendWithAck({
            id: this.generateId(),
            type: 'update-state',
            payload: {
                sessionId,
                expectedVersion,
                agentState
            },
            timestamp: Date.now()
        })
    }

    sendSessionAlive(sessionId: string, thinking: boolean, mode: 'local' | 'remote'): void {
        this.send({
            id: this.generateId(),
            type: 'session-alive',
            payload: {
                sessionId,
                time: Date.now(),
                thinking,
                mode
            },
            timestamp: Date.now()
        })
    }

    sendMachineAlive(machineId: string): void {
        this.send({
            id: this.generateId(),
            type: 'machine-alive',
            payload: {
                machineId,
                time: Date.now()
            },
            timestamp: Date.now()
        })
    }

    ping(): Promise<unknown> {
        return this.sendWithAck({
            id: this.generateId(),
            type: 'ping',
            payload: {},
            timestamp: Date.now()
        }, 5000)
    }

    private startHeartbeat(): void {
        this.stopHeartbeat()

        if (this.options.clientType === 'session-scoped' && this.options.sessionId) {
            this.heartbeatInterval = setInterval(() => {
                if (this.options.sessionId) {
                    this.sendSessionAlive(this.options.sessionId, false, 'remote')
                }
            }, 20_000)
        } else if (this.options.clientType === 'machine-scoped' && this.options.machineId) {
            this.heartbeatInterval = setInterval(() => {
                if (this.options.machineId) {
                    this.sendMachineAlive(this.options.machineId)
                }
            }, 20_000)
        }
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval)
            this.heartbeatInterval = null
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            return
        }

        const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
            this.maxReconnectDelay
        )

        this.reconnectAttempts++
        logger.debug(`[WebSocketClient] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`)

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect()
        }, delay)
    }

    disconnect(): void {
        this.stopHeartbeat()
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        if (this.ws) {
            this.ws.close()
            this.ws = null
        }
    }

    get connected(): boolean {
        return this.authenticated && this.ws?.readyState === WebSocket.OPEN
    }

    private generateId(): string {
        return crypto.randomUUID()
    }
}
