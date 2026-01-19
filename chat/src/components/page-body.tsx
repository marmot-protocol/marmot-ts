import { cn } from "../lib/utils";
import { type ReactNode } from "react";

export function PageBody({
  children,
  center,
}: {
  children: ReactNode;
  center?: boolean;
}) {
  return (
    <div
      className={cn("w-full max-w-4xl space-y-8 p-4", { "mx-auto": center })}
    >
      {children}
    </div>
  );
}
