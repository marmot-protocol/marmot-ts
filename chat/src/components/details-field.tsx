/** @deprecated */
export function DetailsField(props: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden">
      <div className="text-sm text-muted-foreground mb-1">{props.label}</div>
      {props.children}
    </div>
  );
}
