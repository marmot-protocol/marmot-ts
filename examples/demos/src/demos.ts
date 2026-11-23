import type { ComponentType } from "react";

/**
 * The demos shown in the sidebar, grouped into sections. Each `id` is the
 * file's path under `src/demos/` without `.tsx`, and is also the URL hash.
 * Adding a demo means creating the file and adding it here.
 */
export const categories: { label: string; demos: DemoEntry[] }[] = [
  { label: "Groups", demos: [{ id: "groups/clock", title: "Clock group" }] },
];

export type DemoEntry = { id: string; title: string };

export type Demo = DemoEntry & {
  load: () => Promise<{ default: ComponentType }>;
  source: () => Promise<string>;
};

const modules = import.meta.glob<{ default: ComponentType }>(
  "./demos/**/*.tsx",
);
const sources = import.meta.glob<string>("./demos/**/*.tsx", {
  query: "?raw",
  import: "default",
});

const missing = (id: string) => () =>
  Promise.reject(new Error(`No file at src/demos/${id}.tsx`));

/** Every listed demo, in sidebar order, with its loaders attached. */
export const demos: Demo[] = categories.flatMap((category) =>
  category.demos.map((entry) => {
    const path = `./demos/${entry.id}.tsx`;
    return {
      ...entry,
      load: modules[path] ?? missing(entry.id),
      source: sources[path] ?? missing(entry.id),
    };
  }),
);
