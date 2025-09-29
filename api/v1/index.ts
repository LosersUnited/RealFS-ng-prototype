import { SpecBuffer } from "../../real-fs-protocol/type_system.ts";
import { spec, opcode_map, response_spec, control_message, StatOutput } from "../../real-fs-protocol/shared.ts";

import path from "node:path";
import fs from "node:fs/promises";
import fs_regular from "node:fs";
import { promisify } from "node:util";

export const API_VERSION = "0.1";

class MountPointManager {
    private static mount_point: string;

    static setMountPoint(path: string): void {
        this.mount_point = path;
    }

    static getMountPoint(): string {
        return this.mount_point;
    }

    static resolveSecurePath(mountPoint: string, relativePath: string): string {
        const mount = path.resolve(mountPoint) + path.sep;
        // const target = path.resolve(mountPoint, relativePath) + path.sep;
        const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
        const target = path.resolve(mountPoint, cleanPath) + path.sep;

        if (!target.startsWith(mount)) {
            console.log(`${mount} vs ${target}`);
            throw new Error("Path traversal detected: Attempt to escape mount point sandbox");
        }

        return target.slice(0, -1);
    }
}

export { MountPointManager };

const fs_read = promisify(fs_regular.read);
const fs_write = promisify(fs_regular.write);

const S_IFMT = 0o170000;  // bitmask for the file type
const S_IFDIR = 0o040000; // directory
const S_IFREG = 0o100000; // regular file

function handleWs(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const currentMountPoint = MountPointManager.getMountPoint();
    socket.addEventListener("message", async (ev) => {
        const buffer = new Uint8Array(ev.data);
        const specBuf = new SpecBuffer(buffer);
        const head = control_message.read(specBuf);
        if (!specBuf.hasRemaining()) throw new Error("Invalid control message");
        const opCode = head.op_name;
        if (!(opCode in opcode_map)) throw new Error("Unknown operation code");
        const responseMessageBuf = new SpecBuffer();
        control_message.write(responseMessageBuf, opCode, head.id);
        // console.log(responseMessageBuf.getOffset());
        switch (opCode) {
            case "ls": {
                const dirPath = spec[opCode].read(specBuf).path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, dirPath);
                response_spec[opCode].write(responseMessageBuf, await fs.readdir(securePath));
                break;
            }
            case "stat": {
                const filePath = spec[opCode].read(specBuf).path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
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
                const fileData = new Uint8Array(length);
                // const fd = await fs_regular.promises.open(`${currentMountpoint}/${filePath}`, "r");
                const fd = await fs.open(securePath, "r");
                // fs_regular.readSync(fd, fileData, 0, length, options.start);
                // fs_regular.closeSync(fd);
                await fs_read(fd.fd, fileData, 0, length, options.start);
                await fd.close();
                response_spec[opCode].write(responseMessageBuf, fileData);
                break;
            }
            case "touch": {
                const options = spec[opCode].read(specBuf);
                const filePath = options.path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                const stat = options.stat;
                // console.log(stat);
                await fs.utimes(securePath, Number(stat.atime) / 1000, Number(stat.mtime) / 1000);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "write": {
                const options = spec[opCode].read(specBuf);
                const filePath = options.path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                const fd = await fs.open(securePath, "w+");
                await fs_write(fd.fd, options.data, 0, options.data.byteLength, options.offset);
                await fd.close();
                // const fd = fs_regular.openSync(`${currentMountpoint}/${filePath}`, "w+");
                // fs_regular.writeSync(fd, Buffer.from(options.data.buffer), 0, options.data.byteLength, options.offset);
                // fs_regular.closeSync(fd);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "unlink": {
                const filePath = spec[opCode].read(specBuf).path;
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, filePath);
                await fs.unlink(securePath);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "new": {
                const options = spec[opCode].read(specBuf);
                const securePath = MountPointManager.resolveSecurePath(currentMountPoint, options.path);
                let madeDir = false;
                switch (options.opt.mode & S_IFMT) {
                    case S_IFDIR:
                        await fs.mkdir(securePath);
                        madeDir = true;
                        break;
                    case S_IFREG:
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
                await fs.rmdir(securePath);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
            case "move": {
                const options = spec[opCode].read(specBuf);
                const secureSrcPath = MountPointManager.resolveSecurePath(currentMountPoint, options.src_path);
                const secureDstPath = MountPointManager.resolveSecurePath(currentMountPoint, options.dst_path);
                await fs.rename(secureSrcPath, secureDstPath);
                response_spec[opCode].write(responseMessageBuf, true);
                break;
            }
        }
        socket.send(responseMessageBuf.getBuffer());
    });
    return response;
}

export function handler(req: Request, path: string) {
    console.log("API", req.method, path);
    if (path === "ws") {
        return handleWs(req);
    }
    else {
        return new Response(`Not found`, { status: 404 });
    }
}
