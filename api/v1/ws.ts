import { SpecBuffer } from "../../real-fs-protocol/type_system.ts";
import { spec, opcode_map, response_spec, control_message, StatOutput } from "../../real-fs-protocol/shared.ts";

import fs from "node:fs/promises";
import { MountPointManager } from "../mount.ts";

const LOG_LEVEL = parseInt(Deno.env.get("REALFS_LOG_LEVEL") || "0");

function log(level: number, msg: string, ...args: any[]) {
    if (level <= LOG_LEVEL) {
        console.log(`[${level}] ${msg}`, ...args);
    }
}

const S_IFMT = 0o170000;  // bitmask for the file type
const S_IFDIR = 0o040000; // directory
const S_IFREG = 0o100000; // regular file

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

function handleWs(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const currentMountPoint = MountPointManager.getMountPoint();
    log(2, "ws conn");
    socket.addEventListener("message", async (ev) => {
        const t0 = Date.now();
        log(4, `t0: ${t0}`);
        const buffer = new Uint8Array(ev.data);
        log(3, `buf sz: ${buffer.length}`);
        const specBuf = new SpecBuffer(buffer);
        const head = control_message.read(specBuf);
        if (!specBuf.hasRemaining()) throw new Error("Invalid control message");
        const opCode = head.op_name;
        log(2, `op: ${opCode}`);
        log(4, `buf rem: ${specBuf.hasRemaining() ? specBuf.getBuffer().byteLength - specBuf.getOffset() : 0}`);
        if (!(opCode in opcode_map)) throw new Error("Unknown operation code");
        const responseMessageBuf = new SpecBuffer();
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
                    await fs.utimes(securePath, Number(stat.atime) / 1000, Number(stat.mtime) / 1000);
                    await fs.truncate(securePath, stat.size);
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
            }
        }
        catch (e: any) {
            log(1, `err: ${e.message}`);
            log(4, `stack: ${e.stack}`);
            responseMessageBuf.emplaceIntoBuffer((new TextEncoder().encode(`ERR:${JSON.stringify(sanitizeFsError(e, currentMountPoint))}`)));
        }
        log(4, `op dur: ${Date.now() - t0}ms`);
        log(2, `resp sent`);
        socket.send(responseMessageBuf.getBuffer());
    });
    return response;
}

export {
    handleWs,
}
