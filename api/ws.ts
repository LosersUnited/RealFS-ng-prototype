import { SpecBuffer } from "../real-fs-protocol/type_system.ts";
import { MountPointManager } from "./mount.ts";

import { processRequest } from "./processor/index.ts";

function handleWs(req: Request, apiVersion: string): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const currentMountPoint = MountPointManager.getMountPoint();
    socket.addEventListener("message", async (ev) => {
        const responseMessageBuf = new SpecBuffer();
        await processRequest({
            buffer: new Uint8Array(ev.data),
            currentMountPoint,
            emulatedProtoVersion: apiVersion,
            responseMessageBuf,
        });
        socket.send(responseMessageBuf.getBuffer());
    });
    return response;
}

export {
    handleWs,
}
