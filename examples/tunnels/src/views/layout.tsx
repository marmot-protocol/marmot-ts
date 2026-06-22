import type { FC, PropsWithChildren } from "hono/jsx";

const STYLES = `
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #1c2330;
    --border: #30363d;
    --fg: #e6edf3;
    --muted: #8b949e;
    --accent: #4493f8;
    --accent-dim: #1f6feb;
    --fork: #d29922;
    --tip: #3fb950;
    --danger: #f85149;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, .mono { font-family: var(--mono); }
  header.top {
    display: flex; align-items: baseline; gap: 16px;
    padding: 16px 24px; border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  header.top h1 { font-size: 16px; margin: 0; }
  header.top .id { color: var(--muted); font-size: 12px; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .panel {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 18px; margin-bottom: 20px;
  }
  .panel h2 { margin: 0 0 14px; font-size: 14px; text-transform: uppercase;
    letter-spacing: .06em; color: var(--muted); }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 28px; }
  .meta div { font-size: 13px; }
  .meta .k { color: var(--muted); margin-right: 6px; }
  .group-card {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: 10px; background: var(--panel-2);
  }
  .group-card .name { font-weight: 600; }
  .group-card .sub { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-family: var(--mono); border: 1px solid var(--border);
    color: var(--muted);
  }
  .pill.tip { color: var(--tip); border-color: var(--tip); }
  .pill.fork { color: var(--fork); border-color: var(--fork); }
  .pill.canon { color: var(--accent); border-color: var(--accent); }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
  .graph-wrap { overflow-x: auto; padding: 8px 0; }
  .msg { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .msg:last-child { border-bottom: 0; }
  .msg .hdr { display: flex; gap: 10px; align-items: baseline; }
  .msg .who { font-weight: 600; }
  .msg .when { color: var(--muted); font-size: 12px; }
  .msg .kind { font-size: 11px; }
  .msg .body { white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
  .legend { display: flex; gap: 20px; flex-wrap: wrap; color: var(--muted);
    font-size: 12px; margin-top: 8px; }
  .legend span::before { content: "●"; margin-right: 6px; }
  .legend .l-canon::before { color: var(--accent); }
  .legend .l-fork::before { color: var(--fork); }
  .legend .l-tip::before { color: var(--tip); }
  .legend .l-node::before { color: var(--muted); }
  table.heads { width: 100%; border-collapse: collapse; }
  table.heads td, table.heads th { text-align: left; padding: 6px 10px;
    border-bottom: 1px solid var(--border); font-size: 13px; }
  table.heads th { color: var(--muted); font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: .05em; }
  table.heads .mono { font-size: 12px; }
`;

/** The shared HTML shell: dark theme, top bar with the server identity. */
export const Layout: FC<PropsWithChildren<{ title: string; npub: string }>> = (
  props,
) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title}</title>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </head>
    <body>
      <header class="top">
        <h1>
          <a href="/">tunnels</a>
        </h1>
        <span class="id mono">{props.npub}</span>
      </header>
      <main>{props.children}</main>
    </body>
  </html>
);
