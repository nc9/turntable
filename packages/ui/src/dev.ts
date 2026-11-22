// Standalone dev server for the UI (fixture data, HMR). `bun run dev` from packages/ui.
import index from "./index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  routes: { "/*": index },
  development: { hmr: false, console: true },
});
console.log(`turntable ui dev server on ${server.url}`);
