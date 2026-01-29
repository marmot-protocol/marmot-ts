import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";

/**
 * Simple error boundary component that displays errors in an alert.
 * This is a default fallback for all examples to use.
 */
function ErrorFallback({ error }: { error: Error | unknown }) {
  return (
    <div className="alert alert-error">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="stroke-current shrink-0 h-6 w-6"
        fill="none"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <div>
        <div className="font-bold">Error</div>
        <div className="text-sm">
          {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    </div>
  );
}

/**
 * Default error boundary component for examples.
 * Wraps children and displays a simple alert on error.
 */
export default function ErrorBoundary({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ReactErrorBoundary FallbackComponent={ErrorFallback}>
      {children}
    </ReactErrorBoundary>
  );
}
