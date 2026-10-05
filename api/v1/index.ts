import { snapshotHandler } from "./snapshot.ts";
import { handleWs } from "../ws.ts";
import type { Upgrade } from "../../runtime.ts";

export const API_VERSION = "0.1";

export function handler(req: Request, upgrade: Upgrade, path: string) {
    console.log("API", req.method, path);
    if (path === "ws") {
        return handleWs(req, upgrade, API_VERSION);
    }
    else if (path === "snapshot") {
        return snapshotHandler();
    }
    else {
        return new Response(`Not found`, { status: 404 });
    }
}
