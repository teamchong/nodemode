
const d = new Diagram({ theme: "blueprint", direction: "TB" });

// Top: Clients
const browser = d.addBox("Browser\n(xterm.js)", { row: 0, col: 1, color: "users", icon: "user" });
const cli = d.addBox("CLI / Agent\n(claude, curl)", { row: 0, col: 3, color: "users", icon: "user" });

// Worker layer
const worker = d.addBox("Cloudflare Worker\n(stateless router)", { row: 1, col: 2, color: "backend", icon: "cloud", width: 300 });

// Workspace DO
const workspace = d.addBox("Workspace DO\n(per-workspace)", { row: 2, col: 2, color: "orchestration", icon: "server", width: 300 });

// Inside workspace - components
const fsEngine = d.addBox("FsEngine\n(fs module)", { row: 3, col: 0, color: "frontend" });
const procMgr = d.addBox("ProcessManager\n(child_process)", { row: 3, col: 2, color: "frontend" });
const wsHandler = d.addBox("WebSocket\n(stdio streams)", { row: 3, col: 4, color: "frontend" });

// SQLite tables
const sqlite = d.addBox("DO SQLite\n(<1ms reads)", { row: 4, col: 1, color: "database", icon: "database" });
const sqlDetails = d.addBox("files | file_cache\nprocesses | terminal_buf\nworkspace_meta", { row: 5, col: 1, color: "database", width: 280, fontSize: 14 });

// R2
const r2 = d.addBox("R2 Bucket\n(FS_BUCKET)", { row: 4, col: 3, color: "storage", icon: "database" });
const r2Details = d.addBox("{workspace_id}/{path}\nFile content (blobs)\n$0.015/GB/month", { row: 5, col: 3, color: "storage", width: 280, fontSize: 14 });

// Tiered execution
const builtins = d.addBox("Built-in Emulators\ncat ls grep echo\npwd head tail wc", { row: 4, col: -1, color: "cache", width: 240 });
const container = d.addBox("CF Container\n(real Linux)\nnpm node python", { row: 4, col: 5, color: "ai", icon: "docker", width: 240 });

// Connections
d.connect(browser, worker, "HTTP / WS");
d.connect(cli, worker, "HTTP");
d.connect(worker, workspace, "DO.fetch()");

d.connect(workspace, fsEngine, "");
d.connect(workspace, procMgr, "");
d.connect(workspace, wsHandler, "");

d.connect(fsEngine, sqlite, "index + cache");
d.connect(fsEngine, r2, "file content");
d.connect(procMgr, builtins, "$0, <1ms", { style: "dashed" });
d.connect(procMgr, container, "getTcpPort()", { style: "dashed" });
d.connect(procMgr, sqlite, "process table");
d.connect(wsHandler, sqlite, "terminal buffer");

d.connect(sqlite, sqlDetails, "", { endArrowhead: null, style: "dotted" });
d.connect(r2, r2Details, "", { endArrowhead: null, style: "dotted" });

// Groups
d.addGroup("Workspace Durable Object", [workspace, fsEngine, procMgr, wsHandler], { padding: 30 });
d.addGroup("Storage", [sqlite, sqlDetails, r2, r2Details], { padding: 20 });

return d.render({ path: "/Users/steven_chong/Downloads/repos/nodemode/docs/architecture", format: ["excalidraw", "svg"] });
