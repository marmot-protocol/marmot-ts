import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router";

import "./index.css";

import "@/lib/runtime";

import { ThemeProvider } from "./components/theme-providers";
import { SidebarProvider } from "./components/ui/sidebar";

/**
 * GitHub Pages SPA Redirect Handler
 *
 * When 404.html redirects to index.html with ?redirect=/path,
 * this component reads that path and navigates to it.
 */
function RedirectHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const redirectPath = params.get("redirect");

    if (redirectPath) {
      // Remove the redirect param from URL without reloading
      const newUrl =
        window.location.pathname +
        window.location.search
          .replace(/[?&]redirect=[^&]+/, "")
          .replace(/^\?/, "") +
        window.location.hash;
      window.history.replaceState({}, "", newUrl);

      // Navigate to the intended route
      navigate(redirectPath, { replace: true });
    }
  }, [navigate]);

  return null;
}

import ContactsIndexPage from "./pages/contacts/index.tsx";
import ContactsPage from "./pages/contacts.tsx";
import ContactDetailPage from "./pages/contacts/[npub].tsx";
import GroupsPage from "./pages/groups.tsx";
import CreateGroupPage from "./pages/groups/create.tsx";
import GroupDetailPage from "./pages/groups/[id].tsx";
import HomePage from "./pages/index.tsx";
import InvitesPage from "./pages/invites.tsx";
import KeyPackagePage from "./pages/key-packages.tsx";
import KeyPackageDetailPage from "./pages/key-packages/[id].tsx";
import CreateKeyPackagePage from "./pages/key-packages/create.tsx";
import SettingsPage from "./pages/settings.tsx";
import SettingsAccountPage from "./pages/settings/account.tsx";
import SettingsAccountsPage from "./pages/settings/accounts.tsx";
import MarmotSettingsPage from "./pages/settings/marmot";
import SettingsRelaysPage from "./pages/settings/relays.tsx";
import SignInPage from "./pages/signin.tsx";
import SignInIndexPage from "./pages/signin/index.tsx";
import SignInNewUserPage from "./pages/signin/create.tsx";
import SignInExtensionPage from "./pages/signin/extension.tsx";
import SignInBunkerPage from "./pages/signin/bunker.tsx";
import SignInQRPage from "./pages/signin/connect-qr.tsx";
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
            "--sidebar-width": "16rem",
            "--sidebar-width-mobile": "18rem",
          } as React.CSSProperties
        }
      >
        <BrowserRouter basename={import.meta.env.VITE_BASE_PATH}>
          <RedirectHandler />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/groups" element={<GroupsPage />}>
              <Route path="create" element={<CreateGroupPage />} />
              <Route path=":id" element={<GroupDetailPage />} />
            </Route>
            <Route path="/invites" element={<InvitesPage />} />
            <Route path="/key-packages" element={<KeyPackagePage />}>
              <Route path="create" element={<CreateKeyPackagePage />} />
              <Route path=":id" element={<KeyPackageDetailPage />} />
            </Route>
            <Route path="/signin" element={<SignInPage />}>
              <Route index element={<SignInIndexPage />} />
              <Route path="new-user" element={<SignInNewUserPage />} />
              <Route path="extension" element={<SignInExtensionPage />} />
              <Route path="bunker" element={<SignInBunkerPage />} />
              <Route path="qr" element={<SignInQRPage />} />
            </Route>
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
