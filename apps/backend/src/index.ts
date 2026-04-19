import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use("/*", cors());

app.get("/", (c) => {
  return c.json({ message: "Hello World from Meal Planner API!" });
});

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

const port = Number(process.env.PORT) || 3000;

console.log(`Backend server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
