import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

// No <StrictMode>: its double-run effects would create every demo actor twice
// and clutter the relay traffic log.
createRoot(document.getElementById("root")!).render(<App />);
