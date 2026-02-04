import { SpecBuffer } from "../../real-fs-protocol/type_system.ts";
import { MountPointManager } from "../mount.ts";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, ReadStream } from "node:fs";
import { Buffer } from "node:buffer";

const MAGIC = new TextEncoder().encode("SNAPSHOT");
const VERSION = "0.2";

type FileEntry = {
    path: string;
    pathOffset: number;
    type: number;
    mode: number;
    mtime: bigint;
    size: number;
    dataOffset: number;
};

function storeUint64(buf: SpecBuffer, value: bigint) {
    buf.writeFromSpecType("uint32", Number(value & 0xffffffffn) >>> 0);
    buf.writeFromSpecType("uint32", Number((value >> 32n) & 0xffffffffn) >>> 0);
}

function storeInt64(buf: SpecBuffer, value: bigint) {
    storeUint64(buf, value);
}

type SnapshotResponseController = {
    entries: FileEntry[];
    headerData?: Uint8Array;
    pathBytesArray?: Uint8Array[];
    dataEntryIndex: number;
    activeStreams: Set<ReadStream>;
};

export async function snapshotHandler() {
    const activeStreams: Set<ReadStream> = new Set();
    try {
        const currentMountPoint = MountPointManager.getMountPoint();
        const entries: FileEntry[] = [];
        await collectEntries(currentMountPoint, currentMountPoint, entries);
        entries.sort((a, b) => {
            if (a.type !== b.type) {
                return b.type - a.type;
            }
            if (a.path < b.path) return -1;
            if (a.path > b.path) return 1;
            return 0;
        });

        let totalBytes = MAGIC.length;
        const versionBytes = new TextEncoder().encode(VERSION);
        totalBytes += 4 + versionBytes.length; // length of version bytes, version itself
        totalBytes += 4 + 8; // entries count, total bytes so far
        totalBytes += entries.length * (4 + 4 + 4 + 4 + 8 + 8 + 8);
        totalBytes += 4; // path blob size

        const pathBlobOffset = totalBytes;
        // console.log(`Total Bytes: ${totalBytes}`);
        let pathBlobSize = 0;
        const pathBytesArray: Uint8Array[] = [];

        for (const entry of entries) {
            const pathBytes = new TextEncoder().encode(entry.path);
            pathBytesArray.push(pathBytes);
            entry.pathOffset = pathBlobOffset + pathBlobSize;
            pathBlobSize += pathBytes.length;
        }

        totalBytes += pathBlobSize;

        let dataRegionOffset = totalBytes;
        for (const entry of entries) {
            if (entry.type === 0) {
                entry.dataOffset = dataRegionOffset;
                dataRegionOffset += entry.size;
            } else {
                entry.dataOffset = 0;
            }
        }

        totalBytes = dataRegionOffset;

        const spec = new SpecBuffer();
        spec.emplaceIntoBuffer(MAGIC);
        spec.writeFromSpecType("string", versionBytes);
        spec.writeFromSpecType("uint32", entries.length);
        storeUint64(spec, BigInt(totalBytes));

        for (const entry of entries) {
            spec.writeFromSpecType("uint32", entry.pathOffset);
            spec.writeFromSpecType("uint32", entry.type);
            spec.writeFromSpecType("uint32", entry.mode);
            storeInt64(spec, entry.mtime);
            storeUint64(spec, BigInt(entry.size));
            storeUint64(spec, BigInt(entry.dataOffset));
        }
        spec.writeFromSpecType("uint32", pathBlobSize);

        const headerData = spec.getBuffer().slice(0, spec.getOffset());
        // console.log(headerData.byteLength);

        const snapshotStream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                const ctrl = controller as typeof controller & SnapshotResponseController;
                ctrl.entries = entries;
                ctrl.headerData = headerData;
                ctrl.pathBytesArray = pathBytesArray;
                ctrl.dataEntryIndex = 0;
                ctrl.activeStreams = activeStreams;
            },

            pull: async (controller) => {
                try {
                    const ctrl = controller as typeof controller & SnapshotResponseController;

                    if (ctrl.headerData) {
                        controller.enqueue(ctrl.headerData);
                        delete ctrl.headerData;
                        return;
                    }

                    if (ctrl.pathBytesArray) {
                        if (ctrl.pathBytesArray.length > 0) {
                            const pathBlob = Buffer.concat(ctrl.pathBytesArray);
                            controller.enqueue(pathBlob);
                        }
                        delete ctrl.pathBytesArray;
                        return;
                    }

                    while (ctrl.dataEntryIndex < ctrl.entries.length) {
                        const entry = ctrl.entries[ctrl.dataEntryIndex];
                        ctrl.dataEntryIndex++;

                        if (entry.type === 1) {
                            continue;
                        }

                        const securePath = MountPointManager.resolveSecurePath(currentMountPoint, entry.path);
                        const nodeStream = createReadStream(securePath);
                        ctrl.activeStreams.add(nodeStream);

                        for await (const chunk of nodeStream) {
                            controller.enqueue(new Uint8Array(chunk));
                        }

                        ctrl.activeStreams.delete(nodeStream);
                        return;
                    }

                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel: () => {
                for (const stream of activeStreams) {
                    if (stream && typeof stream.destroy === 'function') {
                        stream.destroy();
                    }
                }
                activeStreams.clear();
            }
        });

        return new Response(snapshotStream, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "application/octet-stream",
            }
        });
    } catch (error) {
        for (const stream of activeStreams) {
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
        activeStreams.clear();

        console.error("Snapshot error:", error);
        return new Response(`Error creating snapshot: ${error}`, { status: 500 });
    }
}

async function collectEntries(basePath: string, currentPath: string, entries: FileEntry[]): Promise<void> {
    try {
        const relativePath = path.relative(basePath, currentPath) || '.';
        const stat = await fs.stat(currentPath);

        const type = stat.isDirectory() ? 1 : 0;

        const pathStr = relativePath === '.' ? '' : relativePath.replace(/\\/g, '/');

        entries.push({
            path: "/" + pathStr,
            pathOffset: 0,
            type,
            mode: stat.mode,
            mtime: BigInt(stat.mtime.getTime()),
            size: type === 1 ? 0 : stat.size,
            dataOffset: 0
        });

        if (stat.isDirectory()) {
            const items = await fs.readdir(currentPath);
            for (const item of items) {

                if (item === '.' || item === '..') {
                    continue;
                }
                const itemPath = path.join(currentPath, item);
                await collectEntries(basePath, itemPath, entries);
            }
        }
    } catch (error) {
        console.error(`Error processing path ${currentPath}:`, error);
        throw error;
    }
}
