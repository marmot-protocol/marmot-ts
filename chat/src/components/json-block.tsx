export default function JsonBlock({ value }: { value: any }) {
  return (
    <pre className="overflow-auto">
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}
