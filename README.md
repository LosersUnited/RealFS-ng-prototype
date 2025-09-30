# RealFS server next generation prototype

## What?

RealFS is an application level protocol for handling filesystem-like operations
over WebSockets.

It's a replacement of the old RealFS protocol, which was based on HTTP.

The new version has been designed to be more efficient.

This repository contains a prototype implementation of the RealFS server.

## Why?

This implementation is used to host a server for the RealFS client.

Code for the RealFS client based on ZenFS is hosted on LosersUnited/ZenFS-builds
and bundled as part of the build process.

RealFS client is used in BetterVencord as the filesystem API when RealFS mode is
enabled. In that case, the client assumes the server is running at port 8000.
You should not expose this server publicly. Never.

## How?

To run it, you need Deno installed. You can download it from https://deno.land/.
Then just run `deno run --allow-env --allow-read --allow-write --allow-net index.ts`.

The architecture doesn't require any external dependencies.

## Config

### Port

By default, the server runs on port 8000. This can be changed by setting the
environment variable REALFS_PORT before starting the server.

### Mount point

By default, the server mounts the `mnt` folder that is expected to exist in the
same directory as the server executable.

This can be changed by setting the environment variable REALFS_MOUNT_POINT
before starting the server.

## License

Undecided yet.
