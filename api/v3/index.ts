import { log } from "node:console";
import { spec, response_spec, StatOutput64 } from "../../real-fs-protocol/shared.ts";
import { MountPointManager } from "../mount.ts";
import { snapshotHandler } from "../v2/snapshot.ts";
import { handleWs2 } from "../ws.ts";
import type { Upgrade } from "../../runtime.ts";

import fs from "node:fs/promises";

import { call } from "../errors.ts";

export const API_VERSION = "0.3";

export function handler(req: Request, upgrade: Upgrade, path: string) { // code duplicate because there's always a chance a future version may introduce a new endpoint
    console.log("API", `v${API_VERSION}`, req.method, path);
    if (path === "ws") {
        return handleWs2(req, upgrade, {
            apiVersion: API_VERSION,
            handlers: {
                [API_VERSION]: {
                    "stat64": { // TODO: split
                        inheritedFrom: null,
                        dirtyFromInherit: false,
                        async func(me, ctx) {
                            const filePath = spec[me].read(ctx.inBuf).path;
                            const securePath = MountPointManager.resolveSecurePath(ctx.tr.currentMountPoint, filePath);
                            log(2, `path: ${securePath}`);
                            log(3, `stat: ${filePath}`);
                            const rawStat = await call("stat", () => fs.stat(securePath));
                            const stat: StatOutput64 = {
                                size: BigInt(rawStat.size),
                                mode: rawStat.mode,
                                mtime: BigInt(rawStat.mtime.getTime()),
                                ctime: BigInt(rawStat.ctime.getTime()),
                                atime: BigInt(rawStat.atime.getTime())
                            }
                            response_spec[me].write(ctx.outBuf, stat);
                        }
                    },
                }
            },
        });
    }
    else if (path === "snapshot") {
        return snapshotHandler();
    }
    else {
        return new Response(`Not found`, { status: 404 });
    }
}
