import { snapshotHandler } from "./snapshot.ts";
import { handleWs } from "./ws.ts";

export const API_VERSION = "0.1";

export function handler(req: Request, path: string) {
    console.log("API", req.method, path);
    if (path === "ws") {
        return handleWs(req);
    }
    else if (path === "snapshot") {
        return snapshotHandler();
    }
    else {
        return new Response(`Not found`, { status: 404 });
    }
}
