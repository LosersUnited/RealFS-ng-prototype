export type Syscall =
    | "readdir"
    | "stat"
    | "open"
    | "read"
    | "write"
    | "unlink"
    | "mkdir"
    | "rmdir"
    | "rename"
    | "truncate"
    | "utime";

const ERRNO_INFO: Record<number, [string, string]> = {
    [-1]: ["EPERM", "operation not permitted"],
    [-2]: ["ENOENT", "no such file or directory"],
    [-5]: ["EIO", "i/o error"],
    [-9]: ["EBADF", "bad file descriptor"],
    [-11]: ["EAGAIN", "resource temporarily unavailable"],
    [-12]: ["ENOMEM", "not enough memory"],
    [-13]: ["EACCES", "permission denied"],
    [-16]: ["EBUSY", "resource busy or locked"],
    [-17]: ["EEXIST", "file already exists"],
    [-18]: ["EXDEV", "cross-device link not permitted"],
    [-19]: ["ENODEV", "no such device"],
    [-20]: ["ENOTDIR", "not a directory"],
    [-21]: ["EISDIR", "illegal operation on a directory"],
    [-22]: ["EINVAL", "invalid argument"],
    [-23]: ["ENFILE", "file table overflow"],
    [-24]: ["EMFILE", "too many open files"],
    [-27]: ["EFBIG", "file too large"],
    [-28]: ["ENOSPC", "no space left on device"],
    [-29]: ["ESPIPE", "invalid seek"],
    [-30]: ["EROFS", "read-only file system"],
    [-31]: ["EMLINK", "too many links"],
    [-36]: ["ENAMETOOLONG", "name too long"],
    [-38]: ["ENOSYS", "function not implemented"],
    [-39]: ["ENOTEMPTY", "directory not empty"],
    [-40]: ["ELOOP", "too many symbolic links encountered"],
    [-75]: ["EOVERFLOW", "value too large for defined data type"],
    [-84]: ["EILSEQ", "illegal byte sequence"],
    [-95]: ["ENOTSUP", "operation not supported on socket"],
};

const CODE_TO_ERRNO: Record<string, number> = {};
for (const [errno, [code]] of Object.entries(ERRNO_INFO)) {
    CODE_TO_ERRNO[code] = Number(errno);
}

const SYSCALL_ALIASES: Record<string, Syscall> = {
    scandir: "readdir",
    utimes: "utime",
};

const ERRNO_OVERRIDES: Partial<Record<Syscall, Record<number, number>>> = {
    unlink: { [-39]: -21 },
};

type FsErrorShape = {
    errno?: unknown;
    code?: unknown;
    syscall?: unknown;
    path?: unknown;
    dest?: unknown;
    message?: unknown;
};

const MESSAGE_ERRNOS: Array<[RegExp, number]> = [
    [/^file closed$/i, -9],
];

export const RUNTIME_NOISE_KEYS = [
    "sourceURL",
    "originalLine",
    "originalColumn",
    "originalSource",
    "line",
    "column",
    "fd",
];

function resolveErrno(err: FsErrorShape): number | undefined {
    if (typeof err.errno === "number" && Number.isFinite(err.errno)) return err.errno;
    const fromMessage = typeof err.message === "string" ? /\(os error (-?\d+)\)/.exec(err.message) : null;
    if (fromMessage) return Number(fromMessage[1]);
    if (typeof err.code === "string" && CODE_TO_ERRNO[err.code] !== undefined) return CODE_TO_ERRNO[err.code];
    if (typeof err.message === "string") {
        for (const [pattern, errno] of MESSAGE_ERRNOS) {
            if (pattern.test(err.message.trim())) return errno;
        }
    }
    return undefined;
}

function resolveSyscall(err: FsErrorShape, intended?: Syscall): Syscall | undefined {
    if (intended) return intended;
    if (typeof err.syscall === "string") {
        return SYSCALL_ALIASES[err.syscall] ?? (err.syscall as Syscall);
    }
    if (typeof err.message === "string") {
        const match = /: ([a-z_]+) '/.exec(err.message);
        if (match) return SYSCALL_ALIASES[match[1]] ?? (match[1] as Syscall);
    }
    return undefined;
}

function resolvePath(err: { path?: unknown; dest?: unknown; message?: unknown }): { path?: string; dest?: string } {
    const result: { path?: string; dest?: string } = {};
    if (typeof err.path === "string") result.path = err.path;
    if (typeof err.dest === "string") result.dest = err.dest;
    if (result.path === undefined && typeof err.message === "string") {
        const quoted = /'([^']*)'(?: -> '([^']*)')?/.exec(err.message);
        if (quoted) {
            result.path = quoted[1];
            if (quoted[2] !== undefined) result.dest = quoted[2];
        }
    }
    return result;
}

export function canonicalize(err: unknown, syscall?: Syscall): unknown {
    if (!(err instanceof Error)) return err;

    const loose = err as Error & FsErrorShape;
    let errno = resolveErrno(loose);
    const resolvedSyscall = resolveSyscall(loose, syscall);

    if (errno !== undefined && resolvedSyscall !== undefined) {
        errno = ERRNO_OVERRIDES[resolvedSyscall]?.[errno] ?? errno;
    }

    const info = errno === undefined ? undefined : ERRNO_INFO[errno];

    const bag = loose as unknown as Record<string, unknown>;
    for (const key of RUNTIME_NOISE_KEYS) {
        Reflect.deleteProperty(bag, key);
    }

    if (info === undefined) return err;

    const { path, dest } = resolvePath(loose);

    const parts = [`${info[0]}: ${info[1]}`];
    if (resolvedSyscall) parts.push(resolvedSyscall);
    let message = parts.join(", ");
    if (path !== undefined) message += ` '${path}'`;
    if (dest !== undefined) message += ` -> '${dest}'`;

    loose.name = "Error";
    loose.message = message;
    loose.code = info[0];
    loose.errno = errno;
    if (resolvedSyscall) loose.syscall = resolvedSyscall;
    if (path !== undefined) loose.path = path;
    if (dest !== undefined) loose.dest = dest;

    return err;
}

export async function call<T>(syscall: Syscall, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        throw canonicalize(err, syscall);
    }
}
