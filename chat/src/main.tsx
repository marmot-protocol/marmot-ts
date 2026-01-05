import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import "./index.css";
import App from "./pages/index.tsx";
import SignInPage from "./pages/signin.tsx";
import SettingsPage from "./pages/settings.tsx";
import SettingsRelaysPage from "./pages/settings/relays.tsx";
import SettingsAccountPage from "./pages/settings/account.tsx";
import SettingsAccountsPage from "./pages/settings/accounts.tsx";
import { ThemeProvider } from "./components/theme-providers";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/settings" element={<SettingsPage />}>
            <Route index element={<Navigate to="/settings/relays" replace />} />
            <Route path="relays" element={<SettingsRelaysPage />} />
            <Route path="account" element={<SettingsAccountPage />} />
            <Route path="accounts" element={<SettingsAccountsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
