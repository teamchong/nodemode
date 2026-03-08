import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://teamchong.github.io",
  base: "/nodemode",
  integrations: [
    starlight({
      title: "nodemode",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/teamchong/nodemode",
        },
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        { label: "Getting Started", slug: "getting-started" },
        { label: "Architecture", slug: "architecture" },
        { label: "Filesystem (fs)", slug: "filesystem" },
        { label: "Child Process", slug: "child-process" },
        { label: "WebSocket stdio", slug: "websocket-stdio" },
        { label: "REST API", slug: "rest-api" },
        { label: "Deployment", slug: "deployment" },
      ],
    }),
  ],
});
