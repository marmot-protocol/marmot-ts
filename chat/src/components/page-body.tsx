import { cn } from "../lib/utils";

export function PageBody({
  children,
  center,
}: {
  children: React.ReactNode;
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
