export type OnMessage = (data: Uint8Array) => Uint8Array | void | Promise<Uint8Array | void>;
export type Upgrade = (req: Request, onMessage: OnMessage) => Response | undefined;
export type FetchHandler = (
    req: Request,
    upgrade: Upgrade,
) => Response | undefined | Promise<Response | undefined>;

export interface ServerHandle {
    stop(closeActiveConnections?: boolean): void;
}

interface DenoSocket {
    binaryType: string;
    send(data: Uint8Array): void;
    addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

interface DenoLike {
    serve(
        options: { port: number },
        handler: (req: Request) => Response | undefined | Promise<Response | undefined>,
    ): { shutdown(): void };
    upgradeWebSocket(req: Request): { socket: DenoSocket; response: Response };
}

interface BunSocket {
    data: { id: number };
    send(data: Uint8Array): void;
}

interface BunServerLike {
    upgrade(req: Request, options: { data: { id: number } }): boolean;
}

interface BunLike {
    serve(options: {
        port: number;
        fetch: (req: Request, server: BunServerLike) => Response | undefined | Promise<Response | undefined>;
        websocket: {
            message(ws: BunSocket, message: unknown): void;
            close(ws: BunSocket): void;
        };
    }): { stop(closeActive?: boolean): void };
}

const DENO = (globalThis as unknown as { Deno?: DenoLike }).Deno;
const BUN = (globalThis as unknown as { Bun?: BunLike }).Bun;

if (!DENO && !BUN) {
    throw new Error("RealFS requires either Deno or Bun as the runtime.");
}

const encoder = new TextEncoder();

function toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === "string") return encoder.encode(data);
    throw new Error(`unsupported websocket payload: ${Object.prototype.toString.call(data)}`);
}

function dispatch(onMessage: OnMessage, data: Uint8Array, send: (bytes: Uint8Array) => void): void {
    const reply = (result: Uint8Array | void) => {
        if (result !== undefined && result !== null) send(result);
    };
    const failed = (err: unknown) => console.error("ws message handler failed:", err);

    try {
        const result = onMessage(data);
        if (result && typeof (result as Promise<Uint8Array | void>).then === "function") {
            (result as Promise<Uint8Array | void>).then(reply, failed);
        } else {
            reply(result as Uint8Array | void);
        }
    } catch (err) {
        failed(err);
    }
}

function serveDeno(handler: FetchHandler, port: number): ServerHandle {
    const server = DENO!.serve({ port }, (req) =>
        handler(req, (r, onMessage) => {
            const { socket, response } = DENO!.upgradeWebSocket(r);
            socket.binaryType = "arraybuffer";
            const send = (bytes: Uint8Array) => socket.send(bytes);
            socket.addEventListener("message", (ev) => dispatch(onMessage, toBytes(ev.data), send));
            return response;
        }),
    );
    return { stop: () => server.shutdown() };
}

function serveBun(handler: FetchHandler, port: number): ServerHandle {
    const pending = new Map<number, OnMessage>();
    let nextId = 1;

    const server = BUN!.serve({
        port,
        fetch(req, server) {
            return handler(req, (r, onMessage) => {
                const id = nextId++;
                pending.set(id, onMessage);
                if (server.upgrade(r, { data: { id } })) return undefined;
                pending.delete(id);
                return new Response("expected a websocket upgrade", { status: 400 });
            });
        },
        websocket: {
            message(ws, message) {
                const onMessage = pending.get(ws.data?.id);
                if (!onMessage) return;
                dispatch(onMessage, toBytes(message), (bytes) => ws.send(bytes));
            },
            close(ws) {
                if (ws.data?.id !== undefined) pending.delete(ws.data.id);
            },
        },
    });

    return { stop: (closeActive = true) => server.stop(closeActive) };
}

export function serve(handler: FetchHandler, options: { port: number }): ServerHandle {
    return BUN ? serveBun(handler, options.port) : serveDeno(handler, options.port);
}

export const runtimeName: "deno" | "bun" = BUN ? "bun" : "deno";
