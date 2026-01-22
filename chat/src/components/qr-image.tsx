import { qrcode } from "@libs/qrcode";
import { useMemo } from "react";

interface QRImageProps {
  data: string;
  size?: number;
  className?: string;
}

export default function QRImage({
  data,
  size = 150,
  className = "",
}: QRImageProps) {
  const svg = useMemo(() => qrcode(data, { output: "svg" }), [data]);

  return (
    <img
      src={`data:image/svg+xml;base64,${btoa(svg)}`}
      alt="QR Code"
      className={`rounded-lg p-2 bg-white ${className}`}
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}
