import { snapshotHandler } from "./snapshot.ts";
import { handleWs } from "../ws.ts";
import type { Upgrade } from "../../runtime.ts";

export const API_VERSION = "0.2";

export function handler(req: Request, upgrade: Upgrade, path: string) { // code duplicate because there's always a chance a future version may introduce a new endpoint
    console.log("API", `v${API_VERSION}`, req.method, path);
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
