import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { FC } from "hono/jsx";

const app = new Hono();

const Layout: FC = (props) => {
  return (
    <html>
      <head>
        <title>Tunnel Map</title>
      </head>
      <body>{props.children}</body>
    </html>
  );
};

const Greeting: FC<{ message: string }> = (props) => {
  return (
    <Layout>
      <h1>{props.message}</h1>
    </Layout>
  );
};

app.get("/", (c) => {
  return c.html(<Greeting message="Hello Hono!" />);
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
