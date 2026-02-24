import { bytesToHex } from "@noble/hashes/utils.js";
import { LeafNodeKeyPackage } from "ts-mls/leafNode.js";
import { protocolVersions } from "ts-mls";

import CipherSuiteBadge from "../cipher-suite-badge";
import CredentialTypeBadge from "../credential-type-badge";
import ExtensionBadge from "../extension-badge";
import { formatMlsTimestamp, isLifetimeValid } from "../../../../src/utils";
import { DetailsField } from "../details-field";

/**
 * A reusable component that displays leaf node capabilities and lifetime information.
 */
export function LeafNodeCapabilitiesSection(props: {
  leafNode: LeafNodeKeyPackage;
}) {
  const { leafNode } = props;
  const lifetime = leafNode.lifetime;

  // Check if lifetime is currently valid
  const lifetimeValid = lifetime ? isLifetimeValid(lifetime) : false;

  return (
    <div className="space-y-4">
      {/* Section Header */}
      <div>
        <h3 className="text-lg font-semibold mb-1">Leaf Node Capabilities</h3>
        <p className="text-sm text-base-content/60">
          Supported protocol versions, cipher suites, extensions, and proposals
        </p>
      </div>

      {/* Capabilities Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Versions */}
        <DetailsField label="Protocol Versions">
          <div className="flex flex-wrap gap-2">
            {leafNode.capabilities.versions.map((version) => (
              <span key={version} className="badge badge-primary badge-outline">
                {version} (
                {protocolVersions.mls10 === version ? "mls10" : "Unknown"})
              </span>
            ))}
          </div>
        </DetailsField>

        {/* Ciphersuites */}
        <DetailsField label="Cipher Suites">
          <div className="flex flex-wrap gap-2">
            {leafNode.capabilities.ciphersuites.map((suite) => (
              <CipherSuiteBadge key={suite} cipherSuite={suite} />
            ))}
          </div>
        </DetailsField>

        {/* Credentials */}
        <DetailsField label="Credential Types">
          <div className="flex flex-wrap gap-2">
            {leafNode.capabilities.credentials.map((cred) => (
              <CredentialTypeBadge key={cred} credentialType={cred} />
            ))}
          </div>
        </DetailsField>

        {/* Extensions */}
        <DetailsField label="Extensions">
          <div className="flex flex-wrap gap-2">
            {leafNode.capabilities.extensions.length > 0 ? (
              leafNode.capabilities.extensions.map((ext) => (
                <ExtensionBadge key={ext} extensionType={ext} />
              ))
            ) : (
              <span className="badge badge-error badge-outline">None</span>
            )}
          </div>
        </DetailsField>

        {/* Proposals */}
        <DetailsField label="Proposal Types">
          <div className="flex flex-wrap gap-2">
            {leafNode.capabilities.proposals.length > 0 ? (
              leafNode.capabilities.proposals.map((proposal: number) => (
                <span key={proposal} className="badge badge-info badge-outline">
                  {proposal}
                </span>
              ))
            ) : (
              <span className="text-base-content/40 italic">None</span>
            )}
          </div>
        </DetailsField>
      </div>

      {/* Public Keys Section */}
      <div>
        <h4 className="text-base font-semibold mb-3">Public Keys</h4>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* HPKE Public Key */}
          <DetailsField label="HPKE Public Key">
            <p className="break-all select-all font-mono text-xs">
              {bytesToHex(leafNode.hpkePublicKey)}
            </p>
          </DetailsField>

          {/* Signature Public Key */}
          <DetailsField label="Signature Public Key">
            <p className="break-all select-all font-mono text-xs">
              {bytesToHex(leafNode.signaturePublicKey)}
            </p>
          </DetailsField>
        </div>
      </div>

      {/* Lifetime Information (if available) */}
      {lifetime && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h4 className="text-base font-semibold">Lifetime</h4>
            {lifetimeValid ? (
              <span className="badge badge-success">Valid</span>
            ) : (
              <span className="badge badge-error">Expired/Not Yet Valid</span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <DetailsField label="Not Before">
              <p className="text-sm">
                {formatMlsTimestamp(lifetime.notBefore)}
              </p>
              <p className="text-xs text-base-content/60 font-mono">
                Unix: {lifetime.notBefore.toString()}
              </p>
            </DetailsField>
            <DetailsField label="Not After">
              <p className="text-sm">{formatMlsTimestamp(lifetime.notAfter)}</p>
              <p className="text-xs text-base-content/60 font-mono">
                Unix: {lifetime.notAfter.toString()}
              </p>
            </DetailsField>
          </div>
        </div>
      )}
    </div>
  );
}
