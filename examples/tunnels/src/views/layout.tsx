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
  main.wide { max-width: none; }
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
  .invite .invite-row { display: flex; gap: 18px; align-items: center; }
  .invite svg { border-radius: 6px; display: block; }
  .invite p { margin: 0 0 8px; color: var(--muted); }
  .invite .npub { font-size: 12px; word-break: break-all; color: var(--fg); }
  .hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
  .muted { color: var(--muted); }
  /* user names carry a colored underline keyed to the first 6 hex of the
     pubkey (set inline via text-decoration-color) — line style is shared here */
  .who { font-weight: 600; text-decoration: underline;
    text-decoration-thickness: 2px; text-underline-offset: 2px; }
  .node-link { cursor: pointer; }
  .node-link:hover circle { stroke: var(--fg); }
  .panel h2 .pill { margin-left: 10px; vertical-align: middle; }
  .panel h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
  .sub-h { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 18px 0 10px; display: flex; align-items: center;
    gap: 10px; }
  .fork-card { border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; margin-bottom: 12px; background: var(--panel-2); }
  .fork-hdr { display: flex; gap: 10px; align-items: center; margin-bottom: 8px;
    flex-wrap: wrap; }
  .fork-total { color: var(--accent); font-family: var(--mono); font-size: 12px;
    margin-left: auto; }
  .pill.behind { color: var(--fork); border-color: var(--fork); margin-left: 8px; }
  .pill.caught-up { margin-left: 8px; }
  .pill.prop { color: var(--accent); border-color: var(--accent-dim); }
  .children { margin-top: 12px; display: flex; gap: 8px; align-items: center;
    flex-wrap: wrap; }
  .proposals { list-style: none; padding: 0; margin: 0; }
  .proposals li { display: flex; gap: 10px; align-items: center; padding: 7px 0;
    border-bottom: 1px solid var(--border); }
  .proposals li:last-child { border-bottom: 0; }
  .proposals .who { font-weight: 600; }

  /* conversations timeline */
  .tl-legend { display: flex; gap: 20px; flex-wrap: wrap; color: var(--muted);
    font-size: 12px; }
  .tl-legend span::before { content: "●"; margin-right: 6px; }
  .tl-legend .l-canon::before { color: var(--accent); }
  .tl-legend .l-shared::before { color: var(--muted); }
  .tl-legend .l-diverge::before { color: var(--fork); }
  .timeline-wrap { overflow-x: auto; padding: 4px 2px 16px; }
  .timeline-grid { display: grid; column-gap: 14px; align-items: stretch; }
  .tl-head {
    position: sticky; top: 0; z-index: 2; background: var(--panel);
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
    margin-bottom: 6px;
  }
  .tl-head.canon { border-color: var(--accent); }
  .tl-head-top { display: flex; gap: 8px; align-items: center; }
  .tl-head-sub { color: var(--muted); font-size: 12px; margin-top: 4px;
    font-family: var(--mono); }
  .tl-stop {
    position: relative; margin-left: 7px; padding: 4px 4px 16px 20px;
    border-left: 2px solid var(--border);
  }
  .tl-stop.canon { border-left-color: var(--accent-dim); }
  .tl-stop.shared { opacity: .62; }
  .tl-stop.diverge { border-left-color: var(--fork); }
  .tl-dot {
    position: absolute; left: -8px; top: 7px; width: 13px; height: 13px;
    border-radius: 50%; background: var(--muted); border: 2px solid var(--bg);
  }
  .tl-stop.canon .tl-dot { background: var(--accent); }
  .tl-stop.diverge .tl-dot { background: var(--fork); }
  .tl-node { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .tl-epoch { font-weight: 600; font-size: 13px; }
  .tl-tag { color: var(--muted); font-size: 11px; }
  .tl-node .pill { font-size: 10px; padding: 1px 6px; }
  .tl-commit { color: var(--muted); font-size: 12px; margin: 3px 0 6px; }
  .tl-commit .who { color: var(--fg); font-weight: 600; }
  .tl-nomsg { color: var(--muted); font-size: 11px; font-style: italic; }
  .tl-msgs { display: flex; flex-direction: column; gap: 6px; }
  .tl-msg { background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 7px 9px; }
  .tl-msg-hdr { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .tl-msg-hdr .who { font-weight: 600; font-size: 12px; }
  .tl-msg-hdr .when { color: var(--muted); font-size: 11px; }
  .tl-msg-hdr .kind { font-size: 10px; padding: 1px 6px; }
  .tl-msg-body { white-space: pre-wrap; word-break: break-word; font-size: 13px;
    margin-top: 3px; }
`;

/** The shared HTML shell: dark theme, top bar with the server identity. */
export const Layout: FC<
  PropsWithChildren<{ title: string; npub: string; wide?: boolean }>
> = (props) => (
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
      <main class={props.wide ? "wide" : undefined}>{props.children}</main>
    </body>
  </html>
);
