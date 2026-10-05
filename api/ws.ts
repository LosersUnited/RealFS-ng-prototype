import { SpecBuffer } from "../real-fs-protocol/type_system.ts";
import { MountPointManager } from "./mount.ts";

import { processRequest, VersionIdentity } from "./processor/index.ts";

function handleWs(req: Request, apiVersion: string): Response {
    return handleWs2(req, { apiVersion, handlers: {} });
}

function handleWs2(req: Request, apiIdentity: VersionIdentity): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const currentMountPoint = MountPointManager.getMountPoint();
    socket.addEventListener("message", async (ev) => {
        const responseMessageBuf = new SpecBuffer();
        await processRequest({
            buffer: new Uint8Array(ev.data),
            currentMountPoint,
            emulatedProtoVersion: apiIdentity.apiVersion,
            responseMessageBuf,
            handlers: apiIdentity.handlers,
        });
        socket.send(responseMessageBuf.getBuffer());
    });
    return response;
}

export {
    handleWs,
    handleWs2,
}
