/**
 * Durable Object for managing RPC method registry
 * 
 * Global singleton that maps RPC methods to connection IDs
 */

export class RpcRegistryDO implements DurableObject {
    private methodToConnectionId: Map<string, string> = new Map()
    private connectionIdToMethods: Map<string, Set<string>> = new Map()

    constructor(
        private readonly ctx: DurableObjectState,
        private readonly env: unknown
    ) {}

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const path = url.pathname

        if (path === '/register') {
            return this.handleRegister(request)
        }
        if (path === '/unregister') {
            return this.handleUnregister(request)
        }
        if (path === '/unregister-all') {
            return this.handleUnregisterAll(request)
        }
        if (path === '/get-connection') {
            return this.handleGetConnection(request)
        }

        return new Response('Not found', { status: 404 })
    }

    private async handleRegister(request: Request): Promise<Response> {
        const body = await request.json() as {
            method: string
            connectionId: string
            socketId: string
        }

        this.methodToConnectionId.set(body.method, body.connectionId)

        const methods = this.connectionIdToMethods.get(body.connectionId) ?? new Set()
        methods.add(body.method)
        this.connectionIdToMethods.set(body.connectionId, methods)

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        })
    }

    private async handleUnregister(request: Request): Promise<Response> {
        const body = await request.json() as {
            method: string
            connectionId: string
        }

        const existingConnectionId = this.methodToConnectionId.get(body.method)
        if (existingConnectionId === body.connectionId) {
            this.methodToConnectionId.delete(body.method)
        }

        const methods = this.connectionIdToMethods.get(body.connectionId)
        if (methods) {
            methods.delete(body.method)
            if (methods.size === 0) {
                this.connectionIdToMethods.delete(body.connectionId)
            }
        }

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        })
    }

    private async handleUnregisterAll(request: Request): Promise<Response> {
        const body = await request.json() as {
            connectionId: string
        }

        const methods = this.connectionIdToMethods.get(body.connectionId)
        if (methods) {
            for (const method of methods) {
                const existingConnectionId = this.methodToConnectionId.get(method)
                if (existingConnectionId === body.connectionId) {
                    this.methodToConnectionId.delete(method)
                }
            }
            this.connectionIdToMethods.delete(body.connectionId)
        }

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        })
    }

    private async handleGetConnection(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const method = url.searchParams.get('method')

        if (!method) {
            return new Response(JSON.stringify({ error: 'Method required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            })
        }

        const connectionId = this.methodToConnectionId.get(method) ?? null

        return new Response(JSON.stringify({ connectionId }), {
            headers: { 'Content-Type': 'application/json' }
        })
    }
}
