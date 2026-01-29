import { useEffect, useState, type ComponentType, Suspense } from "react";
import { ErrorBoundary } from "react-error-boundary";
import SideNav from "./components/side-nav";

import { CodeIcon } from "./components/icons.tsx";
import examples, { type Example } from "./examples";
import useHash from "./hooks/use-hash";
import SignInModal from "./components/signin/modal.tsx";
import KeyPackageStoreModal from "./components/key-package-store-modal.tsx";
import GroupStoreModal from "./components/group-store-modal.tsx";
import Settings from "./examples/settings/index.tsx";

function ExampleView(props: { example?: Example; isSettings?: boolean }) {
  const [path, setPath] = useState("");
  const [Component, setComponent] = useState<ComponentType<any> | null>(null);

  // load selected example
  useEffect(() => {
    if (!props.example || props.isSettings) return;
    let cancelled = false;
    setPath(props.example.path.replace(/^\.\//, ""));
    props.example
      .load()
      .then((module: any) => {
        if (cancelled) return;
        if (typeof module.default !== "function")
          throw new Error("Example must be a function");

        console.log("Loaded Example", module.default);
        setComponent(() => module.default);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load example:", error);
        setComponent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [props.example, props.isSettings]);

  return (
    <div className="drawer lg:drawer-open h-full min-h-screen">
      <input id="drawer" type="checkbox" className="drawer-toggle" />

      {/* Main content */}
      <div className="drawer-content flex flex-col relative">
        {/* Navbar */}
        <div className="navbar bg-base-300 w-full">
          <div className="flex-none lg:hidden">
            <label
              htmlFor="drawer"
              aria-label="open sidebar"
              className="btn btn-square btn-ghost"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                className="inline-block h-6 w-6 stroke-current"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 6h16M4 12h16M4 18h16"
                ></path>
              </svg>
            </label>
          </div>
          <div className="mx-2 flex-1 px-2">
            <span className="font-bold text-lg">
              {props.isSettings
                ? "Settings"
                : (props.example?.name ?? "Examples")}
            </span>
          </div>
          {!props.isSettings && (
            <div className="flex-none">
              <a
                target="_blank"
                className="btn btn-sm btn-ghost"
                href={`https://github.com/parres-hq/marmot-ts/tree/${import.meta.env.VITE_REPO_BRANCH || "master"}/examples/src/${path}`}
              >
                <CodeIcon /> Source
              </a>
            </div>
          )}
        </div>

        {/* Page content */}
        {props.isSettings ? (
          <ErrorBoundary
            fallbackRender={({ error }) => (
              <div className="text-red-500">
                {error instanceof Error ? error.message : String(error)}
              </div>
            )}
          >
            <Settings />
          </ErrorBoundary>
        ) : Component ? (
          <ErrorBoundary
            fallbackRender={({ error }) => (
              <div className="text-red-500">
                {error instanceof Error ? error.message : String(error)}
              </div>
            )}
          >
            <Suspense
              fallback={
                <div className="flex justify-center items-center h-full">
                  <span className="loading loading-dots loading-xl"></span>
                </div>
              }
            >
              <Component />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <div className="flex justify-center items-center h-full">
            <span className="loading loading-dots loading-xl"></span>
          </div>
        )}
      </div>

      {/* Sidebar */}
      <SideNav />

      <SignInModal />
      <KeyPackageStoreModal />
      <GroupStoreModal />
    </div>
  );
}

function App() {
  const [example, setExample] = useState<Example | null>(null);
  const [isSettings, setIsSettings] = useState(false);
  const hash = useHash();

  // set example based on hash or fallback to a random example
  useEffect(() => {
    const name = hash.replace(/^#/, "");
    if (name === "settings") {
      setIsSettings(true);
      setExample(null);
    } else {
      setIsSettings(false);
      const example = examples.find((e) => e.id === name);
      if (example) setExample(example);
      else setExample(examples[Math.floor(Math.random() * examples.length)]);
    }
  }, [hash]);

  return <ExampleView example={example ?? undefined} isSettings={isSettings} />;
}

export default App;
