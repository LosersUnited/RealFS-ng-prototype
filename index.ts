import { statSync } from "node:fs";
import process from "node:process";

import * as api from "./api/index.ts";
import { MountPointManager } from "./api/mount.ts";
import { serve, runtimeName, type Upgrade } from "./runtime.ts";

MountPointManager.setMountPoint(process.env.REALFS_MOUNT_POINT || "./mnt");
try {
    const exists = statSync(MountPointManager.getMountPoint());
    if (!exists.isDirectory) {
        throw new Error(`Mount point is not a directory`);
    }
}
catch (err) {
    console.error(`Mount point does not exist or is inaccessible.`);
    console.error("The error was:");
    console.error(err);
    process.exit(1);
}

const handler = ((req: Request, upgrade: Upgrade) => {
    const url = new URL(req.url);
    if (url.pathname === "/") {
        return new Response("RealFS next generation prototype");
    }
    else if (url.pathname.startsWith("/api")) {
        if (url.pathname === "/api") {
            return new Response(JSON.stringify(Object.keys(api)), { headers: { "Content-Type": "application/json" } });
        }
        const version = url.pathname.split("/api/")[1].split("/")[0] as keyof typeof api;
        const api_obj = api[version];
        if (!api_obj) {
            return new Response("404 Not Found", { status: 404 });
        }

        if (url.pathname === `/api/${version}`) {
            return new Response(api_obj.API_VERSION, { headers: { "Content-Type": "application/json" } });
        }

        return api_obj.handler(req, upgrade, url.pathname.split(`/api/${version}/`)[1]);
    }
    else {
        return new Response("404 Not Found", { status: 404 });
    }
});

const port = parseInt(process.env.REALFS_PORT ?? "8000");
serve(handler, { port });

console.log(`RealFS server (${runtimeName}) listening on port ${port}`);
