/**
 * Cloudflare Worker entry point
 * 
 * Handles:
 * - REST API requests
 * - SSE connections
 * - WebSocket upgrades
 * - Static asset serving
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { ConnectionManagerDO } from './ConnectionManagerDO'
import { RpcRegistryDO } from './RpcRegistryDO'
import { SessionManagerDO } from './SessionManagerDO'

export interface Env {
    CLI_API_TOKEN: string
    CONNECTION_MANAGER: DurableObjectNamespace<ConnectionManagerDO>
    RPC_REGISTRY: DurableObjectNamespace<RpcRegistryDO>
    SESSION_MANAGER: DurableObjectNamespace<SessionManagerDO>
    DB: D1Database
    ASSETS: R2Bucket
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url)

        // Handle WebSocket upgrade
        if (url.pathname.startsWith('/ws/cli') && request.headers.get('Upgrade') === 'websocket') {
            return handleWebSocketUpgrade(request, env)
        }

        // Handle SSE
        if (url.pathname === '/api/events') {
            return handleSSE(request, env)
        }

        // Handle REST API
        const app = createApp(env)
        return app.fetch(request, env, ctx)
    }
}

function createApp(env: Env): Hono {
    const app = new Hono()

    app.use('*', cors({
        origin: '*',
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type']
    }))

    // REST API routes (migrated from existing routes)
    app.get('/api/sessions', async (c) => {
        // Implementation similar to existing routes/sessions.ts
        // But using D1 and Durable Objects
        return c.json({ sessions: [] })
    })

    app.post('/api/sessions/:id/messages', async (c) => {
        const sessionId = c.req.param('id')
        const body = await c.req.json()

        // Route to SessionManagerDO
        const sessionManagerId = env.SESSION_MANAGER.idFromName(`session:${sessionId}`)
        const sessionManager = env.SESSION_MANAGER.get(sessionManagerId)
        
        const response = await sessionManager.fetch(new Request('http://internal/send-message', {
            method: 'POST',
            body: JSON.stringify(body)
        }))

        return response
    })

    app.post('/api/sessions/:id/permissions/:requestId/approve', async (c) => {
        const sessionId = c.req.param('id')
        const requestId = c.req.param('requestId')
        const body = await c.req.json()

        // Route to SessionManagerDO
        const sessionManagerId = env.SESSION_MANAGER.idFromName(`session:${sessionId}`)
        const sessionManager = env.SESSION_MANAGER.get(sessionManagerId)
        
        const response = await sessionManager.fetch(new Request('http://internal/approve-permission', {
            method: 'POST',
            body: JSON.stringify({
                requestId,
                ...body
            })
        }))

        return response
    })

    // RPC call endpoint (called by SyncEngine)
    app.post('/api/rpc/:method', async (c) => {
        const method = c.req.param('method')
        const body = await c.req.json()

        // Get connection ID from RpcRegistryDO
        const registryId = env.RPC_REGISTRY.idFromName('rpc-registry:global')
        const registry = env.RPC_REGISTRY.get(registryId)
        
        const registryResponse = await registry.fetch(
            new Request(`http://internal/get-connection?method=${encodeURIComponent(method)}`)
        )
        const { connectionId } = await registryResponse.json() as { connectionId: string | null }

        if (!connectionId) {
            return c.json({ error: 'RPC handler not registered' }, 404)
        }

        // Route to ConnectionManagerDO
        const connectionManagerId = env.CONNECTION_MANAGER.idFromString(connectionId)
        const connectionManager = env.CONNECTION_MANAGER.get(connectionManagerId)
        
        const rpcResponse = await connectionManager.fetch(new Request('http://internal/rpc-request', {
            method: 'POST',
            body: JSON.stringify({
                id: crypto.randomUUID(),
                method,
                params: JSON.stringify(body)
            })
        }))

        const result = await rpcResponse.json()
        return c.json(result)
    })

    return app
}

async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response> {
    // Create new ConnectionManagerDO instance
    const connectionId = env.CONNECTION_MANAGER.idFromName(`connection:${crypto.randomUUID()}`)
    const connectionManager = env.CONNECTION_MANAGER.get(connectionId)

    // Upgrade WebSocket and route to ConnectionManagerDO
    return connectionManager.fetch(request)
}

async function handleSSE(request: Request, env: Env): Promise<Response> {
    // SSE implementation similar to existing routes/events.ts
    // But using Durable Objects for connection management
    
    return streamSSE(request, async (stream) => {
        const subscriptionId = crypto.randomUUID()
        const query = new URL(request.url).searchParams
        const sessionId = query.get('sessionId')
        const machineId = query.get('machineId')

        // Subscribe to SessionManagerDO for updates
        if (sessionId) {
            const sessionManagerId = env.SESSION_MANAGER.idFromName(`session:${sessionId}`)
            const sessionManager = env.SESSION_MANAGER.get(sessionManagerId)
            
            await sessionManager.fetch(new Request('http://internal/sse-subscribe', {
                method: 'POST',
                body: JSON.stringify({
                    subscriptionId,
                    send: async (event: unknown) => {
                        await stream.writeSSE({ data: JSON.stringify(event) })
                    },
                    sendHeartbeat: async () => {
                        await stream.write(': heartbeat\n\n')
                    }
                })
            }))
        }

        // Keep connection alive
        request.signal.addEventListener('abort', () => {
            if (sessionId) {
                const sessionManagerId = env.SESSION_MANAGER.idFromName(`session:${sessionId}`)
                const sessionManager = env.SESSION_MANAGER.get(sessionManagerId)
                sessionManager.fetch(new Request('http://internal/sse-unsubscribe', {
                    method: 'POST',
                    body: JSON.stringify({ subscriptionId })
                })).catch(console.error)
            }
        })
    })
}
