import { useEffect, useRef, useState } from "react";

import { useController } from "../hooks/use-marmot.js";
import { useAppKeybindings } from "../hooks/use-app-keybindings.js";
import { NavigationProvider, useNavigation } from "../hooks/use-navigation.js";
import { ChatView } from "./ChatView.js";
import { Header } from "./Header.js";
import { KeybindingFooter } from "./KeybindingFooter.js";
import { ModalHost, type Modal } from "./ModalHost.js";
import { ProfilePanel } from "./ProfilePanel.js";
import { Sidebar } from "./Sidebar.js";
import { GLOBAL_HINTS, panelHints } from "./hints.js";

export function App(props: {
  onQuit: () => void;
  onLogout: (params: { name: string; relays: string[] }) => void;
}) {
  return (
    <NavigationProvider>
      <AppContent onQuit={props.onQuit} onLogout={props.onLogout} />
    </NavigationProvider>
  );
}

function AppContent(props: {
  onQuit: () => void;
  onLogout: (params: { name: string; relays: string[] }) => void;
}) {
  const controller = useController();
  const nav = useNavigation();
  const started = useRef(false);
  const [modal, setModal] = useState<Modal>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    controller.start().catch((err) => controller.logError(err));
  }, [controller]);

  useAppKeybindings({ modal, setModal, onQuit: props.onQuit });

  const hints = panelHints({
    composing: nav.composing,
    showAllInvites: nav.showAllInvites,
    selectedGroupIsAdmin: nav.selectedGroupIsAdmin,
    activeGroupIsAdmin: nav.activeGroupIsAdmin,
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor="#0e0e16"
    >
      <Header onShowQr={() => setModal({ kind: "myqr" })} />

      <box flexGrow={1} flexDirection="row">
        <Sidebar />
        <ChatView />
        <ProfilePanel />
      </box>

      <KeybindingFooter
        title={nav.focus}
        hints={[...hints[nav.focus], ...GLOBAL_HINTS]}
      />

      <ModalHost modal={modal} setModal={setModal} onLogout={props.onLogout} />
    </box>
  );
}
