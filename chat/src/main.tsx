import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import "./index.css";

import { ThemeProvider } from "./components/theme-providers";
import { SidebarProvider } from "./components/ui/sidebar";

import ContactsIndexPage from "./pages/contacts/index.tsx";
import ContactsPage from "./pages/contacts.tsx";
import ContactDetailPage from "./pages/contacts/[npub].tsx";
import GroupsPage from "./pages/groups.tsx";
import HomePage from "./pages/index.tsx";
import KeyPackagePage from "./pages/key-packages.tsx";
import KeyPackageDetailPage from "./pages/key-packages/[id].tsx";
import CreateKeyPackagePage from "./pages/key-packages/create.tsx";
import SettingsPage from "./pages/settings.tsx";
import SettingsAccountPage from "./pages/settings/account.tsx";
import SettingsAccountsPage from "./pages/settings/accounts.tsx";
import MarmotSettingsPage from "./pages/settings/marmot";
import SettingsRelaysPage from "./pages/settings/relays.tsx";
import SignInPage from "./pages/signin.tsx";
import ToolsPage from "./pages/tools";
import KeyPackageDecoderPage from "./pages/tools/key-package-encoding.tsx";
import GroupMetadataEncodingPage from "./pages/tools/group-metadata-encoding.tsx";
import KeyPackageFeedPage from "./pages/tools/key-package-feed.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "400px",
          } as React.CSSProperties
        }
      >
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/groups" element={<GroupsPage />}></Route>
            <Route path="/key-packages" element={<KeyPackagePage />}>
              <Route path="create" element={<CreateKeyPackagePage />} />
              <Route path=":id" element={<KeyPackageDetailPage />} />
            </Route>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/contacts" element={<ContactsPage />}>
              <Route path=":npub" element={<ContactDetailPage />} />
              <Route index element={<ContactsIndexPage />} />
            </Route>
            <Route path="/tools" element={<ToolsPage />}>
              <Route
                path="key-package-encoding"
                element={<KeyPackageDecoderPage />}
              />
              <Route
                path="group-metadata-encoding"
                element={<GroupMetadataEncodingPage />}
              />
              <Route path="key-package-feed" element={<KeyPackageFeedPage />} />
            </Route>
            <Route path="/settings" element={<SettingsPage />}>
              <Route
                index
                element={<Navigate to="/settings/accounts" replace />}
              />
              <Route path="marmot" element={<MarmotSettingsPage />} />
              <Route path="relays" element={<SettingsRelaysPage />} />
              <Route path="account" element={<SettingsAccountPage />} />
              <Route path="accounts" element={<SettingsAccountsPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SidebarProvider>
    </ThemeProvider>
  </StrictMode>,
);
