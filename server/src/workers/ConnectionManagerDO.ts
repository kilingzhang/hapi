/**
 * Durable Object for managing WebSocket connections
 * 
 * Each WebSocket connection gets its own ConnectionManagerDO instance
 * Handles authentication, message routing, and connection lifecycle
 */

export interface ConnectionMessage {
    id: string
    type: string
    payload: unknown
    timestamp: number
}

export interface AuthPayload {
    token: string
    clientType: 'session-scoped' | 'machine-scoped'
    sessionId?: string | null
    machineId?: string | null
}

export class ConnectionManagerDO implements DurableObject {
    private ws: WebSocket | null = null
    private socketId: string | null = null
    private authenticated = false
    private sessionId: string | null = null
    private machineId: string | null = null
    private clientType: 'session-scoped' | 'machine-scoped' | null = null
    private rooms: Set<string> = new Set()
    private pendingRpcRequests: Map<string, {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timeout: number
    }> = new Map()
    private readonly env: {
        CLI_API_TOKEN: string
        SESSION_MANAGER: DurableObjectNamespace
        RPC_REGISTRY: DurableObjectNamespace
    }

    constructor(
        private readonly ctx: DurableObjectState,
        env: {
            CLI_API_TOKEN: string
            SESSION_MANAGER: DurableObjectNamespace
            RPC_REGISTRY: DurableObjectNamespace
        }
    ) {
        this.env = env
        this.socketId = ctx.id.toString()
    }

    async fetch(request: Request): Promise<Response> {
        // Handle WebSocket upgrade
        if (request.headers.get('Upgrade') === 'websocket') {
            return this.handleWebSocketUpgrade(request)
        }

        // Handle HTTP requests (for RPC calls from other DOs)
        if (request.method === 'POST') {
            return this.handleHttpRequest(request)
        }

        return new Response('Not found', { status: 404 })
    }

    private async handleWebSocketUpgrade(request: Request): Promise<Response> {
        const pair = new WebSocketPair()
        const [client, server] = Object.values(pair)

        this.ws = server
        this.acceptWebSocket(server)

        return new Response(null, {
            status: 101,
            webSocket: client
        })
    }

    private acceptWebSocket(ws: WebSocket): void {
        ws.accept()

        ws.addEventListener('message', async (event) => {
            try {
                const message: ConnectionMessage = JSON.parse(event.data as string)
                await this.handleMessage(message)
            } catch (error) {
                console.error('[ConnectionManagerDO] Error handling message:', error)
                ws.close(1002, 'Invalid message format')
            }
        })

        ws.addEventListener('close', () => {
            this.handleDisconnect()
        })

        ws.addEventListener('error', (error) => {
            console.error('[ConnectionManagerDO] WebSocket error:', error)
            this.handleDisconnect()
        })
    }

    private async handleMessage(message: ConnectionMessage): Promise<void> {
        if (!this.authenticated && message.type !== 'auth') {
            this.ws?.close(1008, 'Not authenticated')
            return
        }

        switch (message.type) {
            case 'auth':
                await this.handleAuth(message)
                break
            case 'rpc:register':
                await this.handleRpcRegister(message)
                break
            case 'rpc:unregister':
                await this.handleRpcUnregister(message)
                break
            case 'rpc:response':
                await this.handleRpcResponse(message)
                break
            case 'message':
                await this.handleClientMessage(message)
                break
            case 'update-metadata':
                await this.handleUpdateMetadata(message)
                break
            case 'update-state':
                await this.handleUpdateState(message)
                break
            case 'session-alive':
                await this.handleSessionAlive(message)
                break
            case 'machine-alive':
                await this.handleMachineAlive(message)
                break
            case 'ping':
                await this.handlePing(message)
                break
            default:
                console.warn('[ConnectionManagerDO] Unknown message type:', message.type)
        }
    }

    private async handleAuth(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as AuthPayload

        if (payload.token !== this.env.CLI_API_TOKEN) {
            this.sendMessage({
                id: message.id,
                type: 'auth:ack',
                payload: {
                    success: false,
                    socketId: null,
                    error: 'Invalid token'
                },
                timestamp: Date.now()
            })
            this.ws?.close(1008, 'Authentication failed')
            return
        }

        this.authenticated = true
        this.clientType = payload.clientType
        this.sessionId = payload.sessionId ?? null
        this.machineId = payload.machineId ?? null

        // Join rooms based on client type
        if (this.sessionId) {
            this.rooms.add(`session:${this.sessionId}`)
        }
        if (this.machineId) {
            this.rooms.add(`machine:${this.machineId}`)
        }

        // Notify SessionManagerDO
        if (this.sessionId) {
            const sessionManagerId = this.env.SESSION_MANAGER.idFromName(`session:${this.sessionId}`)
            const sessionManager = this.env.SESSION_MANAGER.get(sessionManagerId)
            await sessionManager.fetch(new Request('http://internal/join', {
                method: 'POST',
                body: JSON.stringify({
                    socketId: this.socketId,
                    connectionId: this.ctx.id.toString()
                })
            }))
        }

        this.sendMessage({
            id: message.id,
            type: 'auth:ack',
            payload: {
                success: true,
                socketId: this.socketId,
                error: null
            },
            timestamp: Date.now()
        })
    }

    private async handleRpcRegister(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as { method: string }
        const registryId = this.env.RPC_REGISTRY.idFromName('rpc-registry:global')
        const registry = this.env.RPC_REGISTRY.get(registryId)
        
        await registry.fetch(new Request('http://internal/register', {
            method: 'POST',
            body: JSON.stringify({
                method: payload.method,
                connectionId: this.ctx.id.toString(),
                socketId: this.socketId
            })
        }))
    }

    private async handleRpcUnregister(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as { method: string }
        const registryId = this.env.RPC_REGISTRY.idFromName('rpc-registry:global')
        const registry = this.env.RPC_REGISTRY.get(registryId)
        
        await registry.fetch(new Request('http://internal/unregister', {
            method: 'POST',
            body: JSON.stringify({
                method: payload.method,
                connectionId: this.ctx.id.toString()
            })
        }))
    }

    private async handleRpcResponse(message: ConnectionMessage): Promise<void> {
        const pending = this.pendingRpcRequests.get(message.id)
        if (pending) {
            clearTimeout(pending.timeout)
            this.pendingRpcRequests.delete(message.id)
            pending.resolve(message.payload)
        }
    }

    private async handleClientMessage(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as {
            sessionId: string
            content: unknown
            localId?: string | null
        }

        if (!this.sessionId || this.sessionId !== payload.sessionId) {
            return
        }

        const sessionManagerId = this.env.SESSION_MANAGER.idFromName(`session:${payload.sessionId}`)
        const sessionManager = this.env.SESSION_MANAGER.get(sessionManagerId)
        
        await sessionManager.fetch(new Request('http://internal/message', {
            method: 'POST',
            body: JSON.stringify({
                socketId: this.socketId,
                content: payload.content,
                localId: payload.localId
            })
        }))
    }

    private async handleUpdateMetadata(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as {
            sessionId: string
            expectedVersion: number
            metadata: unknown
        }

        const sessionManagerId = this.env.SESSION_MANAGER.idFromName(`session:${payload.sessionId}`)
        const sessionManager = this.env.SESSION_MANAGER.get(sessionManagerId)
        
        const response = await sessionManager.fetch(new Request('http://internal/update-metadata', {
            method: 'POST',
            body: JSON.stringify({
                expectedVersion: payload.expectedVersion,
                metadata: payload.metadata
            })
        }))

        const result = await response.json()
        this.sendMessage({
            id: message.id,
            type: 'update-metadata:ack',
            payload: result,
            timestamp: Date.now()
        })
    }

    private async handleUpdateState(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as {
            sessionId: string
            expectedVersion: number
            agentState: unknown | null
        }

        const sessionManagerId = this.env.SESSION_MANAGER.idFromName(`session:${payload.sessionId}`)
        const sessionManager = this.env.SESSION_MANAGER.get(sessionManagerId)
        
        const response = await sessionManager.fetch(new Request('http://internal/update-state', {
            method: 'POST',
            body: JSON.stringify({
                expectedVersion: payload.expectedVersion,
                agentState: payload.agentState
            })
        }))

        const result = await response.json()
        this.sendMessage({
            id: message.id,
            type: 'update-state:ack',
            payload: result,
            timestamp: Date.now()
        })
    }

    private async handleSessionAlive(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as {
            sessionId: string
            time: number
            thinking?: boolean
            mode?: 'local' | 'remote'
        }

        const sessionManagerId = this.env.SESSION_MANAGER.idFromName(`session:${payload.sessionId}`)
        const sessionManager = this.env.SESSION_MANAGER.get(sessionManagerId)
        
        await sessionManager.fetch(new Request('http://internal/session-alive', {
            method: 'POST',
            body: JSON.stringify({
                time: payload.time,
                thinking: payload.thinking,
                mode: payload.mode
            })
        }))
    }

    private async handleMachineAlive(message: ConnectionMessage): Promise<void> {
        const payload = message.payload as {
            machineId: string
            time: number
        }

        // Similar to session-alive but for machines
        // Implementation omitted for brevity
    }

    private async handlePing(message: ConnectionMessage): Promise<void> {
        this.sendMessage({
            id: message.id,
            type: 'pong',
            payload: {},
            timestamp: Date.now()
        })
    }

    /**
     * Handle RPC request from other Durable Objects (via HTTP)
     */
    private async handleHttpRequest(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const path = url.pathname

        if (path === '/rpc-request') {
            const body = await request.json() as {
                id: string
                method: string
                params: string
            }

            return this.sendRpcRequest(body.id, body.method, body.params)
        }

        if (path === '/broadcast') {
            const body = await request.json() as {
                message: ConnectionMessage
            }

            this.sendMessage(body.message)
            return new Response(JSON.stringify({ success: true }), {
                headers: { 'Content-Type': 'application/json' }
            })
        }

        return new Response('Not found', { status: 404 })
    }

    /**
     * Send RPC request to client and wait for response
     */
    private async sendRpcRequest(id: string, method: string, params: string): Promise<Response> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.pendingRpcRequests.delete(id)
                resolve(new Response(JSON.stringify({
                    success: false,
                    error: 'RPC timeout'
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }))
            }, 30_000)

            this.pendingRpcRequests.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout)
                    resolve(new Response(JSON.stringify({
                        success: true,
                        result: value
                    }), {
                        headers: { 'Content-Type': 'application/json' }
                    }))
                },
                reject: (error) => {
                    clearTimeout(timeout)
                    resolve(new Response(JSON.stringify({
                        success: false,
                        error: error.message
                    }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    }))
                },
                timeout: timeout as unknown as number
            })

            this.sendMessage({
                id,
                type: 'rpc:request',
                payload: {
                    method,
                    params
                },
                timestamp: Date.now()
            })
        })
    }

    private sendMessage(message: ConnectionMessage): void {
        if (this.ws && this.ws.readyState === WebSocket.READY_STATE_OPEN) {
            this.ws.send(JSON.stringify(message))
        }
    }

    private handleDisconnect(): void {
        // Unregister all RPC handlers
        if (this.socketId) {
            const registryId = this.env.RPC_REGISTRY.idFromName('rpc-registry:global')
            const registry = this.env.RPC_REGISTRY.get(registryId)
            registry.fetch(new Request('http://internal/unregister-all', {
                method: 'POST',
                body: JSON.stringify({
                    connectionId: this.ctx.id.toString()
                })
            })).catch(console.error)
        }

        // Notify SessionManagerDO
        if (this.sessionId) {
            const sessionManagerId = this.env.SESSION_MANAGER.idFromName(`session:${this.sessionId}`)
            const sessionManager = this.env.SESSION_MANAGER.get(sessionManagerId)
            sessionManager.fetch(new Request('http://internal/leave', {
                method: 'POST',
                body: JSON.stringify({
                    socketId: this.socketId
                })
            })).catch(console.error)
        }

        this.ws = null
        this.authenticated = false
    }

    /**
     * Broadcast message to this connection (called by SessionManagerDO)
     */
    async broadcast(message: ConnectionMessage): Promise<void> {
        this.sendMessage(message)
    }
}
