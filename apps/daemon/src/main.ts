import { serveDaemon } from "@perishcode/runtime";

declare const BUILD: string;
await serveDaemon(`daemon:${BUILD}`);
