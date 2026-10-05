import { SpecBuffer } from "../../real-fs-protocol/type_system.ts";
import { spec, opcode_map, response_spec, control_message, StatOutput } from "../../real-fs-protocol/shared.ts";
import { MountPointManager } from "../mount.ts";

import fs from "node:fs/promises";

const LOG_LEVEL = parseInt(Deno.env.get("REALFS_LOG_LEVEL") || "0");

function log(level: number, msg: string, ...args: any[]) {
    if (level <= LOG_LEVEL) {
        console.log(`[${level}] ${msg}`, ...args);
    }
}

const S_IFMT = 0o170000;  // bitmask for the file type
const S_IFDIR = 0o040000; // directory
const S_IFREG = 0o100000; // regular file

export type WrappedHandler<T extends string | symbol = keyof typeof opcode_map> = {
    [K in T]?: {
        inheritedFrom: string | null; // inherited version. if inherited has stat64, but current doesn't define it's func as owned, the current carries over from `version` keyed by this.
        dirtyFromInherit: boolean; // if inherited != null, and current functionality != inherited functionality, this should be true. mostly diagnostic.
        func: ((me: K, ctx: { tr: TransitData, inBuf: SpecBuffer, outBuf: SpecBuffer }) => Promise<void>) | null; // null if not owned.
    }
}; // TODO: extend

export type TransitData = {
    emulatedProtoVersion: string;
    buffer: Uint8Array;
    currentMountPoint: string;
    responseMessageBuf: SpecBuffer;
    handlers: {
        // thanks this pattern, the processor knows which version is at fault of declaring this handler.
        [version: string]: WrappedHandler
    };
}
// TransitData's handlers: keyed by version, the caller defines it's own handlers. for example, because processor shouldn't assume a version declares a handler from v0.2+, if one wants to add something like stat64, the split makes more sense. the context is passed as arguments, and the processor assumes the handler executes some kind of operation and then mutates its own context. I'd prefer no returning the value, as that would mean special handling according to a case.

export type VersionIdentity = {
    apiVersion: string;
    handlers: TransitData["handlers"];
};

function serializeError(err: { [key: string]: any }) {
    if (!(err instanceof Error)) {
        return err;
    }
    const serialized = {
        // @ts-ignore
        name: err.name,
        // @ts-ignore
        message: err.message,
        stack: err.stack,
        ...err,
    } as { [key: string]: any };
    for (const key of Object.getOwnPropertyNames(err)) {
        if (!(key in serialized)) {
            serialized[key] = (err as any)[key];
        }
    }
    return serialized;
}

function sanitizeFsError(err: any, removePrefix: string) {
    if (!(err instanceof Error)) return err;

    const clone = { ...serializeError(err) };

    if (clone.path && clone.path.startsWith(removePrefix)) {
        clone.path = clone.path.replace(removePrefix, '');
    }

    if (clone.dest && clone.dest.startsWith(removePrefix)) {
        clone.dest = clone.dest.replace(removePrefix, '');
    }

    if (clone.message) {
        clone.message = clone.message.replace(removePrefix, '');
    }
    if (clone.stack) {
        clone.stack = clone.stack.replace(new RegExp(removePrefix, 'g'), '');
    }

    return clone;
}

type HandlerEntry<K extends keyof typeof opcode_map> = NonNullable<WrappedHandler[K]>;
type HandlerFuncOrNull<K extends keyof typeof opcode_map = keyof typeof opcode_map> = HandlerEntry<K>["func"];

function recurseFuncResolve<K extends keyof typeof opcode_map>(at: TransitData["handlers"], opCode: K, curVer: string): [HandlerFuncOrNull<K>, string[]] {
    const versionStack = [curVer];
    const handle = at[curVer]?.[opCode];
    if (handle === undefined) {
        throw new Error(`unsatisfied handler: version "${curVer}" declares no entry for ${opCode}`);
    }
    if (handle.func === null && handle.inheritedFrom === null) {
        throw new Error(`unsatisfied handler, declared but not filled? (${curVer}/${opCode})`);
    }
    let assignedFunc = handle.func;
    if (assignedFunc === null) {
        const [oldFunc, newStack] = recurseFuncResolve(at, opCode, handle.inheritedFrom!);
        versionStack.push(...newStack);
        assignedFunc = oldFunc;
    }
    return [assignedFunc, versionStack];
}

export async function processRequest(req: TransitData) {
    const buffer = req.buffer;
    const currentMountPoint = req.currentMountPoint;
    const responseMessageBuf = req.responseMessageBuf;
    const t0 = Date.now();
    log(4, `t0: ${t0}`);
    log(3, `buf sz: ${buffer.length}`);
    const specBuf = new SpecBuffer(buffer);
    const head = control_message.read(specBuf);
    if (!specBuf.hasRemaining()) throw new Error("Invalid control message");
    const opCode = head.op_name;
    log(2, `op: ${opCode}`);
    log(4, `buf rem: ${specBuf.hasRemaining() ? specBuf.getBuffer().byteLength - specBuf.getOffset() : 0}`);
    if (!(opCode in opcode_map)) throw new Error("Unknown operation code");
    // const responseMessageBuf = new SpecBuffer(); // experiment
    control_message.write(responseMessageBuf, opCode, head.id);
    log(3, `resp buf offset: ${responseMessageBuf.getOffset()}`);
    try {
        switch (opCode) {
            case "ls": {
                const dirPath = spec[opCode].read(specBuf).path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, dirPath);
                log(2, `path: ${securePath}`);
                log(3, `ls: ${dirPath}`);
                response_spec[opCode].write(responseMessageBuf, await fs.readdir(securePath));
                break;
            }
            case "stat": {
                const filePath = spec[opCode].read(specBuf).path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                log(2, `path: ${securePath}`);
                log(3, `stat: ${filePath}`);
                const rawStat = await fs.stat(securePath);
                const stat: StatOutput = {
                    size: rawStat.size,
                    mode: rawStat.mode,
                    mtime: BigInt(rawStat.mtime.getTime()),
                    ctime: BigInt(rawStat.ctime.getTime()),
                    atime: BigInt(rawStat.atime.getTime())
                }
                response_spec[opCode].write(responseMessageBuf, stat);
                break;
            }
            case "read": {
                const options = spec[opCode].read(specBuf);
                const filePath = options.path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                const length = options.end - options.start;
                log(2, `path: ${securePath}`);
                log(3, `read: ${filePath} ${length}b @${options.start}`);
                const fileData = new Uint8Array(length);
                const fd = await fs.open(securePath, "r");
                await fd.read(fileData, 0, length, options.start);
                await fd.close();
                response_spec[opCode].write(responseMessageBuf, fileData);
                break;
            }
            case "touch": {
                const options = spec[opCode].read(specBuf);
                const filePath = options.path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                const stat = options.stat;
                log(2, `path: ${securePath}`);
                log(3, `touch: ${filePath} sz:${stat.size}`);
                await fs.truncate(securePath, stat.size);
                await fs.utimes(securePath, Number(stat.atime) / 1000, Number(stat.mtime) / 1000);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "write": {
                const options = spec[opCode].read(specBuf);
                const filePath = options.path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                const fd = await fs.open(securePath, "r+");
                log(2, `path: ${securePath}`);
                log(3, `write: ${filePath} ${options.data.byteLength}b @${options.offset}`);
                await fd.write(options.data, 0, options.data.byteLength, options.offset);
                await fd.close();
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "unlink": {
                const filePath = spec[opCode].read(specBuf).path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                log(2, `path: ${securePath}`);
                log(3, `unlink: ${filePath}`);
                await fs.unlink(securePath);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "new": {
                const options = spec[opCode].read(specBuf);
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, options.path);
                log(2, `path: ${securePath}`);
                let madeDir = false;
                switch (options.opt.mode & S_IFMT) {
                    case S_IFDIR:
                        log(3, `mkdir: ${options.path}`);
                        await fs.mkdir(securePath);
                        madeDir = true;
                        break;
                    case S_IFREG:
                        log(3, `create: ${options.path}`);
                        await fs.writeFile(securePath, "");
                        break;
                }
                response_spec[opCode].write(responseMessageBuf, {
                    size: madeDir ? 4096 : 0,
                    mode: options.opt.mode,
                    mtime: BigInt(Date.now()),
                    ctime: BigInt(Date.now()),
                    atime: BigInt(Date.now()),
                });
                break;
            }
            case "rmdir": {
                const filePath = spec[opCode].read(specBuf).path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                log(2, `path: ${securePath}`);
                log(3, `rmdir: ${filePath}`);
                await fs.rmdir(securePath);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "move": {
                const options = spec[opCode].read(specBuf);
                const secureSrcPath = MountPointManager.resolveSecurePath(currentMountPoint, options.src_path);
                const secureDstPath = MountPointManager.resolveSecurePath(currentMountPoint, options.dst_path);
                log(2, `src: ${secureSrcPath}`);
                log(2, `dst: ${secureDstPath}`);
                log(3, `move: ${options.src_path} -> ${options.dst_path}`);
                await fs.rename(secureSrcPath, secureDstPath);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            default: {
                if (req.emulatedProtoVersion in req.handlers) {
                    const handlersForMe = req.handlers[req.emulatedProtoVersion];
                    const handle = handlersForMe[opCode];
                    if (handle) {
                        const state = {
                            assignedFunc: handle.func,
                            versionStack: [req.emulatedProtoVersion]
                        };
                        if (state.assignedFunc === null) {
                            const [fn, vs] = recurseFuncResolve(req.handlers, opCode, req.emulatedProtoVersion);
                            state.assignedFunc = fn;
                            state.versionStack.push(...vs);
                        }
                        if (!state.assignedFunc) {
                            throw new Error(`there's nothing we can do. func for ${opCode} is gone (visited ${state.versionStack.join(",")})`);
                        }
                        await state.assignedFunc(opCode, { tr: req, inBuf: specBuf, outBuf: responseMessageBuf });
                        break;
                    }
                }
                // break;
                throw new Error("no such opcode " + opCode);
            }
        }
    }
    catch (e: any) {
        log(1, `err: ${e.message}`);
        log(4, `stack: ${e.stack}`);
        responseMessageBuf.emplaceIntoBuffer((new TextEncoder().encode(`ERR:${JSON.stringify(sanitizeFsError(e, currentMountPoint))}`)));
    }
    log(4, `op dur: ${Date.now() - t0}ms`);
    log(2, `resp sent`);
}
