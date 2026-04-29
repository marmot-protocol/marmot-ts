import type { ClientState } from "ts-mls";
import DataView from "./index";

/**
 * A component that displays the ClientState data structure
 * with proper formatting for BigInt, Uint8Array, and Map values.
 * Hides the clientConfig field which contains non-serializable functions.
 */
export default function ClientStateDataView(props: {
  clientState: ClientState;
}) {
  return (
    <DataView
      data={props.clientState}
      options={{
        ignorePaths: ["clientConfig"],
      }}
    />
  );
}
