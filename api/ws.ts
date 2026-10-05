import { SpecBuffer } from "../real-fs-protocol/type_system.ts";
import { MountPointManager } from "./mount.ts";

import { processRequest, VersionIdentity } from "./processor/index.ts";
import type { Upgrade } from "../runtime.ts";

function handleWs(req: Request, upgrade: Upgrade, apiVersion: string): Response | undefined {
    return handleWs2(req, upgrade, { apiVersion, handlers: {} });
}

function handleWs2(req: Request, upgrade: Upgrade, apiIdentity: VersionIdentity): Response | undefined {
    const currentMountPoint = MountPointManager.getMountPoint();
    return upgrade(req, async (data) => {
        const responseMessageBuf = new SpecBuffer();
        await processRequest({
            buffer: data,
            currentMountPoint,
            emulatedProtoVersion: apiIdentity.apiVersion,
            responseMessageBuf,
            handlers: apiIdentity.handlers,
        });
        return responseMessageBuf.getBuffer().subarray(0, responseMessageBuf.getOffset());
    });
}

export {
    handleWs,
    handleWs2,
}
