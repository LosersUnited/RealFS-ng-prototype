import path from "node:path";

class MountPointManager {
    private static mount_point: string;

    static setMountPoint(path: string): void {
        this.mount_point = path;
    }

    static getMountPoint(): string {
        return this.mount_point;
    }

    static resolveSecurePath(mountPoint: string, relativePath: string): string {
        const mount = path.resolve(mountPoint) + path.sep;
        // const target = path.resolve(mountPoint, relativePath) + path.sep;
        const cleanPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
        const target = path.resolve(mountPoint, cleanPath) + path.sep;

        if (!target.startsWith(mount)) {
            console.log(`${mount} vs ${target}`);
            throw new Error("Path traversal detected: Attempt to escape mount point sandbox");
        }

        return target.slice(0, -1);
    }
}

export { MountPointManager };
