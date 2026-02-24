import { useMemo, useState } from "react";
import examples from "../examples";
import useHash from "../hooks/use-hash";
import { useObservable } from "../hooks/use-observable";
import { keyPackageCount$ } from "../lib/key-package-store";
import { groupCount$ } from "../lib/groups";
import AccountSwitcher from "./accounts/picker";

export default function SideNav() {
  const [searchTerm, setSearchTerm] = useState<string>("");
  const hash = useHash();
  const localKeyPackages = useObservable(keyPackageCount$);
  const localGroups = useObservable(groupCount$);

  const filtered = useMemo(
    () =>
      examples.filter((item) =>
        item.id.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
    [searchTerm],
  );

  return (
    <div className="drawer-side">
      <label
        htmlFor="drawer"
        aria-label="open sidebar"
        className="drawer-overlay"
      ></label>
      <div className="menu bg-base-200 text-base-content min-h-full flex flex-col">
        <div className="flex-none">
          <input
            type="text"
            placeholder="Search..."
            className="input input-bordered w-full"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <ul className="menu menu-lg px-0 font-mono w-xs flex-1 overflow-y-auto">
          {filtered.map((item) => (
            <li key={item.id}>
              <a
                href={"#" + item.id}
                className={
                  "text-sm " + (hash === "#" + item.id ? "menu-active" : "")
                }
              >
                {item.name}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex-none p-2 border-t border-base-300 space-y-1">
          <button
            className="btn btn-ghost w-full justify-start gap-2"
            onClick={() =>
              (
                document.getElementById(
                  "key_package_store_modal",
                ) as HTMLDialogElement
              )?.showModal()
            }
          >
            Key Packages{" "}
            {localKeyPackages !== undefined && `(${localKeyPackages})`}
          </button>
          <button
            className="btn btn-ghost w-full justify-start gap-2"
            onClick={() =>
              (
                document.getElementById(
                  "group_store_modal",
                ) as HTMLDialogElement
              )?.showModal()
            }
          >
            Groups {localGroups !== undefined && `(${localGroups})`}
          </button>
          <a
            href="#settings"
            className={
              "btn btn-ghost w-full justify-start gap-2 " +
              (hash === "#settings" ? "btn-active" : "")
            }
          >
            Settings
          </a>
        </div>
        <AccountSwitcher />
      </div>
    </div>
  );
}
