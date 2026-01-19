import { type KeyPackage, type PrivateKeyPackage } from "ts-mls";
import DataView from "./index";

/**
 * A component that displays the raw MLS key package data structure
 * with proper formatting for BigInt and Uint8Array values
 */
export default function KeyPackageDataView(props: {
  keyPackage: KeyPackage | PrivateKeyPackage;
}) {
  return <DataView data={props.keyPackage} />;
}
