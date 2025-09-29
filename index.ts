import * as api from "./api/index.ts";

api.v1.MountPointManager.setMountPoint(Deno.env.get("REALFS_MOUNT_POINT") || "./mnt");

Deno.serve((req) => {
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

        return api_obj.handler(req, url.pathname.split(`/api/${version}/`)[1]);
    }
    else {
        return new Response("404 Not Found", { status: 404 });
    }
});
