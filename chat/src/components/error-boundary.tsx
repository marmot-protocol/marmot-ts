import { AlertCircle } from "lucide-react";
import { type ReactNode } from "react";
import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

/**
 * Simple error boundary component that displays errors in an alert.
 * This is a default fallback for all examples to use.
 */
function ErrorFallback({ error }: { error: Error | unknown }) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>
        {error instanceof Error ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Default error boundary component for examples.
 * Wraps children and displays a simple alert on error.
 */
export default function ErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ReactErrorBoundary FallbackComponent={ErrorFallback}>
      {children}
    </ReactErrorBoundary>
  );
}
